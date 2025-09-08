// src/lib/server/scanner
// This file contains the MarketScanner class, responsible for all scanning logic.
// It periodically scans trading symbols for trade signals using a provided strategy,
// checks database-driven alerts, and sends Telegram notifications for triggered signals and alerts.
// Features include concurrent processing, jitter for API rate limits, cooldowns to prevent spam,
// retries for transient errors, and heartbeat messages for monitoring.

// Import required services and types
import { ExchangeService } from './services/exchange';
import { TelegramService } from './services/telegram';
import { dbService } from './db';
import { Strategy, type TradeSignal } from './strategy';

// Configuration options for the scanner
type ScannerOptions = {
    intervalMs: number; // Scan cycle interval (ms)
    concurrency: number; // Max concurrent symbol processes
    cooldownMs?: number; // Cooldown between alerts per symbol (ms)
    jitterMs?: number; // Random delay to stagger API calls (ms)
    retries?: number; // Retries for transient errors
    heartbeatEvery?: number; // Send heartbeat every N scans
    requireAtrFeasibility?: boolean; // Check if 3x ATR meets ROI target
};

/**
 * The MarketScanner class handles periodic scanning of trading symbols.
 * It generates trade signals, checks database alerts, and sends notifications.
 * Supports concurrent processing, error retries, and cooldowns to prevent alert spam.
 */
export class MarketScanner {
    private running = false; // Flag to indicate if scanner is active
    private timer: NodeJS.Timeout | null = null; // Timer for periodic scans
    private scanCount = 0; // Counter for total scans performed
    private lastAlertAt: Record<string, number> = {}; // Timestamps of last alerts per symbol

    /**
     * Constructor initializes the scanner with dependencies and options.
     * @param exchange - Service for fetching market data
     * @param strategy - Logic for generating trade signals
     * @param symbols - List of symbols to scan (e.g., ['BTC/USDT', 'ETH/USDT'])
     * @param telegram - Service for sending alerts
     * @param opts - Configuration options with defaults
     */
    constructor(
        private readonly exchange: ExchangeService,
        private readonly strategy: Strategy,
        private readonly symbols: string[],
        private readonly telegram: TelegramService,
        private readonly opts: ScannerOptions = {
            intervalMs: 15000, // 15 seconds per scan cycle
            concurrency: 3, // Process 3 symbols concurrently
            cooldownMs: 5 * 60_000, // 5-minute cooldown
            jitterMs: 250, // 250ms jitter
            retries: 1, // 1 retry
            heartbeatEvery: 20, // Heartbeat every 20 scans
            requireAtrFeasibility: true // Require ATR check
        }
    ) {}

    /**
     * Starts the scanner, running an initial scan and scheduling periodic ones.
     * Prevents multiple starts by checking the running flag.
     */
    start(): void {
        if (this.running) return; // Already running, do nothing
        this.running = true;

        // Run first scan immediately
        void this.runScanCycle();
        // Schedule future scans
        this.timer = setInterval(() => {
            if (!this.running) return;
            void this.runScanCycle();
        }, this.opts.intervalMs);
    }

    /**
     * Stops the scanner by clearing the timer and setting the running flag to false.
     */
    stop(): void {
        this.running = false;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    /**
     * Executes a single scan cycle over all symbols.
     * Handles concurrency, sends heartbeats, and processes both signals and alerts.
     */
    async runScanCycle(): Promise<void> {
        const { concurrency, jitterMs = 0, retries = 1, heartbeatEvery } = this.opts;
        this.scanCount += 1;

        // Send heartbeat if configured and interval reached
        if (heartbeatEvery && this.scanCount % heartbeatEvery === 0) {
            this.telegram
                .sendMessage(`Heartbeat: scan #${this.scanCount} over ${this.symbols.length} symbols.`)
                .catch(() => {}); // Ignore errors to avoid crashing
        }

        // Queue of symbols to process (copy to avoid mutating original)
        const queue = [...this.symbols];
        // Create concurrent workers
        const workers = Array.from(
            { length: Math.min(concurrency, queue.length) },
            () => this.processWorker(queue, jitterMs, retries)
        );

        // Await all workers
        await Promise.all(workers);
    }

    /**
     * Worker function that processes symbols from the queue until empty.
     * Applies jitter and retries for each symbol.
     * @param queue - Shared queue of symbols
     * @param jitterMs - Delay jitter
     * @param retries - Number of retries
     */
    private async processWorker(queue: string[], jitterMs: number, retries: number): Promise<void> {
        while (queue.length) {
            const symbol = queue.shift();
            if (!symbol) break;

            // Apply jitter delay to avoid API rate limits
            if (jitterMs > 0) {
                await new Promise((r) => setTimeout(r, Math.floor(Math.random() * jitterMs)));
            }

            try {
                // Process signal generation and alert checking with retries
                await this.withRetries(() => this.processSymbol(symbol), retries);
            } catch (err) {
                // Notify on error without crashing
                const msg = (err as Error)?.message ?? String(err);
                this.telegram.sendMessage(`Error processing ${symbol}: ${msg}`).catch(() => {});
            }
        }
    }

    /**
     * Processes a single symbol: fetches data, generates signal, checks database alerts, sends notifications.
     * @param symbol - The symbol to process
     */
    private async processSymbol(symbol: string): Promise<void> {
        // Fetch OHLCV data
        const ohlcv = this.exchange.getOHLCV(symbol);
        if (!ohlcv || ohlcv.length < 200) return; // Need 200 candles for analysis

        // Extract and validate OHLCV arrays
        const highs = ohlcv.map(c => Number(c[2])).filter(v => !isNaN(v));
        const lows = ohlcv.map(c => Number(c[3])).filter(v => !isNaN(v));
        const closes = ohlcv.map(c => Number(c[4])).filter(v => !isNaN(v));
        const volumes = ohlcv.map(c => Number(c[5])).filter(v => !isNaN(v));
        if (closes.length < 200) return; // Validate sufficient data after filtering

        const currentPrice = closes.at(-1)!;

        // Generate trade signal
        const signal = this.strategy.generateSignal({
            symbol,
            highs,
            lows,
            closes,
            volumes,
        });

        // Process trading signals (if not 'hold')
        if (signal.signal !== 'hold') {
            await this.processTradeSignal(symbol, signal, currentPrice);
        }

        // Process database-driven alerts
        await this.processDatabaseAlerts(symbol, signal, currentPrice, highs, lows, closes, volumes);
    }

    /**
     * Processes a trade signal, applying ATR feasibility and cooldown checks, and sends a Telegram alert.
     * @param symbol - The trading symbol
     * @param signal - The generated trade signal
     * @param currentPrice - The current price
     */
    private async processTradeSignal(symbol: string, signal: TradeSignal, currentPrice: number): Promise<void> {
        // Check ATR feasibility if enabled
        if (this.opts.requireAtrFeasibility !== false) {
            const atr = this.strategy.lastAtr;
            if (atr && atr > 0) {
                const atrMovePct = (3 * atr / currentPrice) * 100;
                if (atrMovePct < this.strategy.riskRewardTarget) return; // Insufficient volatility
            }
        }

        // Check cooldown to prevent alert spam
        const now = Date.now();
        const last = this.lastAlertAt[symbol] ?? 0;
        const cooldownMs = this.opts.cooldownMs ?? 5 * 60_000;
        if (now - last < cooldownMs) return;

        // Update last alert time
        this.lastAlertAt[symbol] = now;

        // Format Telegram message for signal
        const lines = [
            signal.signal === 'buy' ? 'BUY SIGNAL' : 'SELL SIGNAL',
            `Symbol: ${symbol}`,
            `Confidence: ${signal.confidence}%`,
            `Price: $${currentPrice.toFixed(4)}`,
        ];
        if (signal.stopLoss) lines.push(`Stop: $${signal.stopLoss.toFixed(4)}`);
        if (signal.takeProfit) lines.push(`Take Profit: $${signal.takeProfit.toFixed(4)} (~${this.strategy.riskRewardTarget}%)`);
        if (signal.reason?.length) {
            lines.push('Reasons:');
            for (const r of signal.reason.slice(0, 6)) lines.push(`   - ${r}`);
        }

        // Send Telegram notification
        await this.telegram.sendMessage(lines.join('\n'));
    }

    /**
     * Processes database-driven alerts for a symbol, checking conditions and sending notifications.
     * @param symbol - The trading symbol
     * @param signal - The generated trade signal
     * @param currentPrice - The current price
     * @param highs - Array of high prices
     * @param lows - Array of low prices
     * @param closes - Array of close prices
     * @param volumes - Array of volume data
     */
    private async processDatabaseAlerts(
        symbol: string,
        signal: TradeSignal,
        currentPrice: number,
        highs: number[],
        lows: number[],
        closes: number[],
        volumes: number[]
    ): Promise<void> {
        // Fetch active alerts for this symbol
        const alerts = await dbService.getAlertsBySymbol(symbol);

        // Check each alert
        for (const alert of alerts) {
            let triggered = false;
            let triggerReason = '';

            // Evaluate alert conditions
            if (
                (alert.condition === 'price >' && currentPrice > alert.targetPrice) ||
                (alert.condition === 'price <' && currentPrice < alert.targetPrice) ||
                (alert.condition === 'crosses_above_ema200' && signal.reason.some(r => r.includes('Golden Cross'))) ||
                (alert.condition === 'crosses_below_ema200' && signal.reason.some(r => r.includes('Death Cross')))
            ) {
                triggered = true;
                triggerReason = alert.condition;
            }

            if (triggered) {
                // Update alert status in database (uncomment to enable)
                // await dbService.updateAlertStatus(alert.id, 'triggered');

                // Format Telegram message for alert
                const msg = [
                    `🔔 Alert Triggered: ${symbol}`,
                    `• Condition: ${triggerReason}`,
                    `• Signal: ${signal.signal.toUpperCase()}`,
                    `• Price: $${currentPrice.toFixed(4)}`,
                    `• Indicators: ${signal.reason.join(', ')}`,
                    `• ROI Est: ${this.strategy.lastAtr ? ((3 * this.strategy.lastAtr / currentPrice) * 100).toFixed(2) + '%' : 'N/A'}`,
                    alert.note ? `• Note: ${alert.note}` : ''
                ].filter(Boolean).join('\n');

                try {
                    await this.telegram.sendMessage(msg);
                } catch (err) {
                    console.error(`Failed to send Telegram message for ${symbol} alert:`, err);
                }
            }
        }
    }

    /**
     * Retries an async function with exponential backoff.
     * @param fn - Function to retry
     * @param retries - Max retries
     * @returns Result of fn
     */
    private async withRetries<T>(fn: () => Promise<T>, retries: number): Promise<T> {
        let err: unknown;
        for (let i = 0; i <= retries; i++) {
            try {
                return await fn();
            } catch (e) {
                err = e;
                await new Promise((r) => setTimeout(r, 300 * (i + 1))); // Backoff: 300ms, 600ms, etc.
            }
        }
        throw err;
    }
}
