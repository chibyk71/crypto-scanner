// src/lib/server/scanner.ts
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
import { config } from './config/settings';

// Configuration options for the scanner, allowing customization of its behavior.
type ScannerOptions = {
    intervalMs: number; // Scan cycle interval (ms), e.g., 60000ms = 60 seconds.
    concurrency: number; // Max number of symbols processed concurrently to manage resource usage.
    cooldownMs?: number; // Cooldown period (ms) between alerts for the same symbol (default: 5 minutes).
    jitterMs?: number; // Random delay (ms) to stagger API calls and avoid rate limits (e.g., 250ms).
    retries?: number; // Number of retries for transient errors (e.g., network issues).
    heartbeatEvery?: number; // Send a heartbeat message every N scans to confirm scanner is running.
    requireAtrFeasibility?: boolean; // Check if 3x ATR (Average True Range) meets the strategy’s ROI target.
};

/**
 * The MarketScanner class handles periodic scanning of trading symbols.
 * It generates trade signals, checks database alerts, and sends notifications.
 * Supports concurrent processing, error retries, and cooldowns to prevent alert spam.
 */
export class MarketScanner {
    // Tracks whether the scanner is active to prevent starting multiple instances.
    private running = false;

    // Stores the Node.js timer for scheduling periodic scans, allowing clean shutdown.
    private timer: NodeJS.Timeout | null = null;

    // Counts the total number of scan cycles for sending heartbeat messages.
    private scanCount = 0;

    // Maps each symbol to the timestamp (ms) of its last alert to enforce cooldowns.
    private lastAlertAt: Record<string, number> = {};

    /**
     * Constructor initializes the scanner with dependencies and options.
     * @param exchange - Service for fetching market data (OHLCV).
     * @param strategy - Logic for generating trade signals (buy, sell, hold).
     * @param symbols - List of symbols to scan (e.g., ['BTC/USDT', 'ETH/USDT']).
     * @param telegram - Service for sending Telegram notifications.
     * @param opts - Configuration options with sensible defaults.
     */
    constructor(
        private readonly exchange: ExchangeService,
        private readonly strategy: Strategy,
        private readonly symbols: string[],
        private readonly telegram: TelegramService,
        private readonly opts: ScannerOptions = {
            intervalMs: config.pollingInterval, // Scan every 60 seconds.
            concurrency: 3, // Process up to 3 symbols concurrently.
            cooldownMs: 5 * 60_000, // 5-minute cooldown per symbol.
            jitterMs: 250, // 250ms jitter to avoid rate limits.
            retries: 1, // Retry once on transient errors.
            heartbeatEvery: config.heartBeatInterval, // Heartbeat every X scans.
            requireAtrFeasibility: true // Require ATR-based volatility check.
        }
    ) { }

    /**
     * Starts the scanner, running an initial scan and scheduling periodic ones.
     * Prevents multiple starts by checking the running flag.
     */
    start(): void {
        if (this.running) return; // Guard against starting multiple times.
        this.running = true; // Mark scanner as active.

        // Run the first scan immediately.
        void this.runScanCycle();
        // Schedule subsequent scans at the configured interval (opts.intervalMs).
        this.timer = setInterval(() => {
            if (!this.running) return; // Skip if scanner was stopped.
            void this.runScanCycle(); // Run a scan cycle.
        }, this.opts.intervalMs);
    }

    /**
     * Stops the scanner by clearing the timer and setting the running flag to false.
     */
    stop(): void {
        this.running = false; // Mark scanner as inactive.
        if (this.timer) {
            clearInterval(this.timer); // Clear the scheduled timer.
            this.timer = null; // Reset timer reference.
        }
    }

    /**
     * Executes a single scan cycle over all symbols.
     * Handles concurrency, sends heartbeats, and processes both signals and alerts.
     */
    async runScanCycle(): Promise<void> {
        const { concurrency, jitterMs = 0, retries = 1, heartbeatEvery } = this.opts;
        this.scanCount += 1; // Increment scan counter.

        // Send a heartbeat message to Telegram if configured and the scan count matches the interval.
        if (heartbeatEvery && this.scanCount % heartbeatEvery === 0) {
            this.telegram
                .sendMessage(`Heartbeat: scan #${this.scanCount} over ${this.symbols.length} symbols.`)
                .catch(() => { }); // Ignore Telegram errors to avoid crashing the scanner.
        }

        // Create a queue of symbols to process (copy to avoid modifying the original array).
        const queue = [...this.symbols];
        // Create worker tasks to process symbols concurrently, up to the concurrency limit.
        const workers = Array.from(
            { length: Math.min(concurrency, queue.length) }, // Limit to concurrency or queue size.
            () => this.processWorker(queue, jitterMs, retries) // Each worker processes symbols.
        );

        // Wait for all workers to complete processing.
        await Promise.all(workers);
    }

    /**
     * Worker function that processes symbols from the queue until empty.
     * Applies jitter and retries for each symbol.
     * @param queue - Shared queue of symbols.
     * @param jitterMs - Random delay to avoid rate limits.
     * @param retries - Number of retries for errors.
     */
    private async processWorker(queue: string[], jitterMs: number, retries: number): Promise<void> {
        while (queue.length) {
            const symbol = queue.shift(); // Take the next symbol from the queue.
            if (!symbol) break; // Exit if no symbol (defensive check).

            // Apply jitter (random delay) to avoid hitting API rate limits.
            if (jitterMs > 0) {
                await new Promise((r) => setTimeout(r, Math.floor(Math.random() * jitterMs)));
            }

            try {
                // Process the symbol with retries for transient errors (e.g., network issues).
                await this.withRetries(() => this.processSymbol(symbol), retries);
            } catch (err) {
                // Notify errors via Telegram without crashing the scanner.
                const msg = (err as Error)?.message ?? String(err);
                this.telegram.sendMessage(`Error processing ${symbol}: ${msg}`).catch(() => { });
            }
        }
    }

    /**
     * Processes a single symbol: fetches data, generates signal, checks database alerts, sends notifications.
     * @param symbol - The symbol to process (e.g., 'BTC/USDT').
     */
    private async processSymbol(symbol: string): Promise<void> {
        // Fetch OHLCV data (Open, High, Low, Close, Volume) for the symbol.
        const ohlcv = this.exchange.getOHLCV(symbol);
        // Skip if no data or insufficient data (less than 200 candles for robust analysis).
        if (!ohlcv || ohlcv.length < config.historyLength) return;

        // Extract OHLCV components into arrays and filter out invalid (NaN) values.
        const highs = ohlcv.map(c => Number(c[2])).filter(v => !isNaN(v)); // High prices.
        const lows = ohlcv.map(c => Number(c[3])).filter(v => !isNaN(v)); // Low prices.
        const closes = ohlcv.map(c => Number(c[4])).filter(v => !isNaN(v)); // Close prices.
        const volumes = ohlcv.map(c => Number(c[5])).filter(v => !isNaN(v)); // Volume data.
        // Skip if there are fewer than 200 valid close prices after filtering.
        if (closes.length < config.historyLength) return;

        const currentPrice = closes.at(-1)!; // Get the latest closing price.

        // Generate a trade signal using the strategy’s logic.
        const signal = this.strategy.generateSignal({
            symbol,
            highs,
            lows,
            closes,
            volumes,
        });

        // Process trade signals (buy or sell) separately from alerts.
        if (signal.signal !== 'hold') {
            await this.processTradeSignal(symbol, signal, currentPrice);
        }

        // Process database-driven alerts for additional conditions.
        await this.processDatabaseAlerts(symbol, signal, currentPrice);
    }

    /**
     * Processes a trade signal, applying ATR feasibility and cooldown checks, and sends a Telegram alert.
     * @param symbol - The trading symbol.
     * @param signal - The generated trade signal (buy or sell).
     * @param currentPrice - The current price of the symbol.
     */
    private async processTradeSignal(symbol: string, signal: TradeSignal, currentPrice: number): Promise<void> {
        // Check if the trade is feasible based on ATR (Average True Range) if enabled.
        if (this.opts.requireAtrFeasibility !== false) {
            const atr = this.strategy.lastAtr; // Get the last calculated ATR from the strategy.
            if (atr && atr > 0) {
                const atrMovePct = (3 * atr / currentPrice) * 100; // Calculate potential move as a percentage.
                // Skip if the potential move is less than the strategy’s risk-reward target.
                if (atrMovePct < this.strategy.riskRewardTarget) return;
            }
        }

        // Enforce cooldown to prevent spamming alerts for the same symbol.
        const now = Date.now();
        const last = this.lastAlertAt[symbol] ?? 0; // Get last alert time or 0 if none.
        const cooldownMs = this.opts.cooldownMs ?? 5 * 60_000; // Default to 5 minutes.
        if (now - last < cooldownMs) return; // Skip if within cooldown period.

        // Update the last alert time for this symbol.
        this.lastAlertAt[symbol] = now;

        // Format the Telegram message for the trade signal.
        const lines = [
            signal.signal === 'buy' ? 'BUY SIGNAL' : 'SELL SIGNAL', // Signal type.
            `Symbol: ${symbol}`, // Symbol being traded.
            `Confidence: ${signal.confidence}%`, // Confidence level of the signal.
            `Price: $${currentPrice.toFixed(4)}`, // Current price (4 decimal places).
        ];
        // Include stop-loss if provided.
        if (signal.stopLoss) lines.push(`Stop: $${signal.stopLoss.toFixed(4)}`);
        // Include take-profit and risk-reward target if provided.
        if (signal.takeProfit) lines.push(`Take Profit: $${signal.takeProfit.toFixed(4)} (~${this.strategy.riskRewardTarget}%)`);
        // Include up to 6 reasons for the signal, if provided.
        if (signal.reason?.length) {
            lines.push('Reasons:');
            for (const r of signal.reason.slice(0, 6)) lines.push(`   - ${r}`);
        }

        // Send the formatted message to Telegram.
        await this.telegram.sendMessage(lines.join('\n'));
    }

    /**
     * Processes database-driven alerts for a symbol, checking conditions and sending notifications.
     * @param symbol - The trading symbol.
     * @param signal - The generated trade signal.
     * @param currentPrice - The current price.
     */
    private async processDatabaseAlerts(
        symbol: string,
        signal: TradeSignal,
        currentPrice: number,
    ): Promise<void> {
        // Fetch all active alerts for this symbol from the database.
        const alerts = await dbService.getAlertsBySymbol(symbol);

        // Check each alert to see if its condition is satisfied.
        for (const alert of alerts) {
            let triggered = false; // Track whether the alert is triggered.
            let triggerReason = ''; // Store the reason for triggering (e.g., 'price >').

            // Evaluate alert conditions against current price or signal reasons.
            if (
                // Price-based conditions: check if the current price exceeds or falls below the target.
                (alert.condition === 'price >' && currentPrice > alert.targetPrice) ||
                (alert.condition === 'price <' && currentPrice < alert.targetPrice) ||
                // EMA-based conditions: check for Golden Cross (bullish) or Death Cross (bearish) in signal reasons.
                (alert.condition === 'crosses_above_ema200' && signal.reason.some(r => r.includes('Golden Cross'))) ||
                (alert.condition === 'crosses_below_ema200' && signal.reason.some(r => r.includes('Death Cross')))
            ) {
                triggered = true; // Mark the alert as triggered.
                triggerReason = alert.condition; // Record the condition that caused the trigger.
            }

            // If the alert is triggered, process it.
            if (triggered) {
                // Note: The line to update alert status is commented out in the original code.
                // Uncomment to enable updating the alert status in the database.
                // await dbService.updateAlertStatus(alert.id, 'triggered');

                // Format the Telegram message for the alert.
                const msg = [
                    `🔔 Alert Triggered: ${symbol}`, // Alert header with symbol.
                    `• Condition: ${triggerReason}`, // Condition that triggered the alert.
                    `• Signal: ${signal.signal.toUpperCase()}`, // Buy/sell/hold signal.
                    `• Price: $${currentPrice.toFixed(4)}`, // Current price (4 decimal places).
                    `• Indicators: ${signal.reason.join(', ')}`, // Reasons for the signal (e.g., technical indicators).
                    // Estimated ROI based on 3x ATR, if available.
                    `• ROI Est: ${this.strategy.lastAtr ? ((3 * this.strategy.lastAtr / currentPrice) * 100).toFixed(2) + '%' : 'N/A'}`,
                    // Include user-provided note, if any.
                    alert.note ? `• Note: ${alert.note}` : ''
                ].filter(Boolean).join('\n'); // Join non-empty lines with newlines.

                try {
                    // Send the formatted message to Telegram.
                    await this.telegram.sendMessage(msg);
                } catch (err) {
                    // Log any errors sending the Telegram message to the console without crashing.
                    console.error(`Failed to send Telegram message for ${symbol} alert:`, err);
                }
            }
        }
    }

    /**
     * Retries an async function with exponential backoff for transient errors.
     * @param fn - The function to retry.
     * @param retries - Maximum number of retries.
     * @returns The result of the function or throws the last error.
     */
    private async withRetries<T>(fn: () => Promise<T>, retries: number): Promise<T> {
        let err: unknown; // Store the last error encountered.
        for (let i = 0; i <= retries; i++) { // Try up to retries + 1 times.
            try {
                return await fn(); // Attempt the operation.
            } catch (e) {
                err = e; // Capture the error.
                // Wait with exponential backoff (300ms, 600ms, 900ms, etc.) before retrying.
                await new Promise((r) => setTimeout(r, 300 * (i + 1)));
            }
        }
        throw err; // Throw the last error if all retries fail.
    }
}
