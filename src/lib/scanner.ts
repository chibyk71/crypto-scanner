// src/lib/scanner.ts
// =============================================================================
// MARKET SCANNER – CORE ENGINE
// Scans all symbols → generates signals → simulates outcomes → trains ML model
// Fully compatible with your new 5-tier labeling (-2 to +2) and new DB schema
// =============================================================================

import { ExchangeService } from './services/exchange';
import { dbService } from './db';
import { Strategy } from './strategy';
import { createLogger } from './logger';
import { config } from './config/settings';
import type { OhlcvData, SignalLabel, TradeSignal } from '../types';
import { AlertEvaluatorService } from './services/alertEvaluator';
import { mlService } from './services/mlService';                    // ← Singleton MLService
import type { TelegramBotController } from './services/telegramBotController';
import { simulateTrade } from './services/simulateTrade';

const logger = createLogger('MarketScanner');

type ScannerMode = 'single' | 'periodic';
type CooldownBackend = 'database' | 'memory';

interface CachedHtf {
    data: OhlcvData;
    lastCloseTime: number;      // Timestamp of last closed HTF candle
    lastFetchTime: number;  // When we last fetched from API
}

type ScannerOptions = {
    mode?: ScannerMode;
    intervalMs?: number;
    concurrency?: number;
    cooldownMs?: number;
    jitterMs?: number;
    retries?: number;
    heartbeatCycles?: number;
    requireAtrFeasibility?: boolean;
    cooldownBackend?: CooldownBackend;
};

/**
 * Main scanner class — heart of the entire trading system
 * Responsibilities:
 *  • Fetch fresh market data (primary + HTF)
 *  • Generate signals using Strategy
 *  • Filter signals (R:R, cooldown, deduplication)
 *  • Send Telegram alerts
 *  • Simulate every signal → get real PnL & R-multiple
 *  • Feed outcome into MLService for continuous training
 */
export class MarketScanner {
    private running = false;
    private isScanning = false;
    private scanTimer: NodeJS.Timeout | null = null;
    private scanCount = 0;

    // Cooldown & deduplication tracking
    private lastAlertAt: Record<string, number> = {};           // memory backend only
    private lastSignal: Record<string, { signal: TradeSignal; price: number }> = {};

    // Higher Timeframe cache – avoid fetching 1h data every 3 minutes
    private htfCache: Record<string, CachedHtf> = {};

    private alertEvaluator = new AlertEvaluatorService();

    private readonly opts: Required<ScannerOptions>;

    /**
     * Initializes the MarketScanner with dependencies and configuration.
     * @param exchangeService - Service for fetching market data and executing trades.
     * @param telegramService - Service for sending Telegram notifications.
     * @param strategy - Strategy instance for generating trade signals.
     * @param symbols - Array of symbols to scan (e.g., ['BTC/USDT', 'ETH/USDT']).
     * @param opts - Scanner configuration options.
     */
    constructor(
        private readonly exchangeService: ExchangeService,
        private readonly telegramService: TelegramBotController | null,
        private readonly strategy: Strategy,
        private readonly symbols: string[],
        opts: ScannerOptions = {}
    ) {
        this.opts = {
            mode: 'periodic',
            intervalMs: config.scanner.scanIntervalMs ?? 60_000,
            concurrency: 4,
            cooldownMs: 8 * 60_1000,           // 8 minutes between signals per symbol
            jitterMs: 300,
            retries: 2,
            heartbeatCycles: config.scanner.heartBeatInterval ?? 60,
            requireAtrFeasibility: true,
            cooldownBackend: 'database',
            ...opts,
        };

        logger.info(`MarketScanner initialized for ${symbols.length} symbols`, {
            mode: this.opts.mode,
            symbols,
            intervalSec: this.opts.intervalMs / 1000,
        });
    }

    // ===========================================================================
    // PUBLIC CONTROL METHODS
    // ===========================================================================
    /**
     * Starts the scanner in single or periodic mode.
     * - Periodic mode runs scans at regular intervals.
     * - Single mode runs one scan and stops.
     * @throws {Error} If scanner is already running.
     */
    public async start(): Promise<void> {
        if (this.running) {
            logger.warn('Scanner already running');
            return;
        }
        this.running = true;

        this.exchangeService.clearCache();
        logger.info('OHLCV cache cleared on start');

        if (this.opts.mode === 'periodic') {
            await this.scanAllSymbols(); // immediate first scan
            this.scanTimer = setInterval(() => void this.scanAllSymbols(), this.opts.intervalMs);
            logger.info(`Periodic scanning started every ${this.opts.intervalMs / 1000}s`);
        } else {
            await this.scanAllSymbols();
            this.running = false;
        }
    }

    public stop(): void {
        this.running = false;
        if (this.scanTimer) {
            clearInterval(this.scanTimer);
            this.scanTimer = null;
        }
        logger.info('MarketScanner stopped');
    }

    // ===========================================================================
    // MAIN SCAN CYCLE
    // ===========================================================================
    private async scanAllSymbols(): Promise<void> {
        if (this.isScanning) {
            logger.warn('Previous scan still running – skipping');
            return;
        }
        this.isScanning = true;
        const start = Date.now();
        const cycle = this.opts.cooldownBackend === 'database'
            ? await dbService.incrementHeartbeatCount()
            : ++this.scanCount;

        logger.info(`Scan cycle #${cycle} started`, { symbols: this.symbols.length });

        try {
            // Process all symbols in parallel with limited concurrency
            const queue = [...this.symbols];
            const workers = Array.from({ length: Math.min(this.opts.concurrency, queue.length) }, () =>
                this.processWorker(queue)
            );
            await Promise.all(workers);

            // Check custom user alerts after all data is fresh
            await this.checkCustomAlerts();

            // Send heartbeat every N cycles
            if (cycle % this.opts.heartbeatCycles === 0) {
                const duration = Date.now() - start;
                const msg = `Heartbeat: Scan #${cycle} completed in ${duration}ms | ${this.symbols.length} symbols`;
                await this.telegramService?.sendMessage(msg);
                logger.info(msg);
            }
        } catch (err) {
            logger.error('Scan cycle crashed', { error: err });
            await this.telegramService?.sendMessage(`Scan failed: ${(err as Error).message}`);
        } finally {
            this.isScanning = false;
            logger.info(`Scan cycle #${cycle} finished in ${Date.now() - start}ms`);
        }
    }

    /**
     * Processes the symbol queue for concurrent scanning.
     * - Applies jitter to prevent API rate limit issues.
     * @param queue - Array of symbols to process.
     * @private
     */
    private async processWorker(queue: string[]): Promise<void> {
        while (queue.length) {
            const symbol = queue.shift();
            if (!symbol) break;
            // Random delay between 0 and jitterMs to spread API calls
            if (this.opts.jitterMs > 0) {
                await new Promise(r => setTimeout(r, Math.random() * this.opts.jitterMs));
            }
            await this.withRetries(() => this.processSymbol(symbol), this.opts.retries);
        }
    }

    // ===========================================================================
    // PROCESS SINGLE SYMBOL
    // ===========================================================================
    /**
     * Processes a single symbol, generating and acting on trade signals.
     * - Fetches OHLCV data, generates signals, and executes trades if applicable.
     * @param symbol - Trading symbol (e.g., 'BTC/USDT').
     * @private
     */
    private async processSymbol(symbol: string): Promise<void> {
        try {
            // 1. Get primary timeframe data (e.g. 3m)
            const primaryData = await this.getPrimaryData(symbol);
            if (!primaryData || primaryData.closes.length < config.historyLength) return;

            // 2. Get higher timeframe data (e.g. 1h) – smart caching
            const htfData = await this.getHtfData(symbol);
            if (!htfData || htfData.closes.length < config.historyLength) return;

            const currentPrice = primaryData.closes.at(-1)!;

            // 3. Generate signal
            const signal = this.strategy.generateSignal({
                symbol,
                primaryData,
                htfData,
                price: currentPrice,
                atrMultiplier: config.strategy.atrMultiplier,
                riskRewardTarget: config.strategy.riskRewardTarget,
                trailingStopPercent: config.strategy.trailingStopPercent,
            });

            if (signal.signal !== 'hold') {
                await this.handleTradeSignal(symbol, signal, currentPrice, primaryData, htfData);
            }
        } catch (err) {
            logger.error(`Failed processing ${symbol}`, { error: err });
        }
    }

    private async getPrimaryData(symbol: string): Promise<OhlcvData | null> {
        const live = this.exchangeService.getPrimaryOhlcvData(symbol);
        if (live && live.length >= config.historyLength) {
            return this.exchangeService.toOhlcvData(live.slice(-config.historyLength), symbol);
        }
        // Fallback to API fetch
        return await this.exchangeService.getOHLCV(
            symbol,
            config.scanner.primaryTimeframe,
            undefined,
            undefined,
            true
        );
    }

    private async getHtfData(symbol: string): Promise<OhlcvData | null> {
        const tf = config.scanner.htfTimeframe;
        const ms = ExchangeService.toTimeframeMs(tf);
        const now = Date.now();
        const currentCandleStart = Math.floor(now / ms) * ms;

        const cached = this.htfCache[symbol];
        const shouldRefresh =
            !cached ||
            cached.lastCloseTime < currentCandleStart ||
            now - cached.lastFetchTime > 5 * 60_1000;

        if (shouldRefresh) {
            const data = await this.exchangeService.getOHLCV(symbol, tf, undefined, undefined, true);
            if (data && data.closes.length >= config.historyLength) {
                this.htfCache[symbol] = {
                    data,
                    lastCloseTime: data.timestamps.at(-1)!,
                    lastFetchTime: now,
                };
                logger.debug(`HTF refreshed: ${symbol} ${tf}`);
            }
            return data ?? null;
        }
        return cached.data;
    }

    // ===========================================================================
    // HANDLE SIGNAL → NOTIFY + SIMULATE + TRAIN
    // ===========================================================================
    /**
         * Processes a trade signal, executing trades and collecting training data.
         * - Validates signal feasibility, applies cooldown, and executes trades in testnet/live mode.
         * - Logs trades to the database and collects ML training samples.
         * @param symbol - Trading symbol.
         * @param signal - Trade signal with confidence, stop loss, take profit, etc.
         * @param currentPrice - Current market price.
         * @private
         */
    private async handleTradeSignal(
        symbol: string,
        signal: TradeSignal,
        price: number,
        primaryData: OhlcvData,
        htf: OhlcvData
    ): Promise<void> {
        // 1. Deduplication
        const last = this.lastSignal[symbol];
        if (
            last &&
            last.signal.signal === signal.signal &&
            Math.abs(last.price - price) < 1e-6 &&
            Math.abs((last.signal.stopLoss ?? 0) - (signal.stopLoss ?? 0)) < 1e-6
        ) {
            return; // exact same signal
        }

        // 2. R:R feasibility check
        if (this.opts.requireAtrFeasibility && signal.stopLoss && signal.takeProfit) {
            const risk = signal.signal === 'buy' ? price - signal.stopLoss : signal.stopLoss - price;
            const reward = signal.signal === 'buy' ? signal.takeProfit - price : price - signal.takeProfit;
            if (risk <= 0 || reward / risk < config.strategy.riskRewardTarget - 0.1) {
                logger.debug(`Poor R:R → skipped`, { symbol, rr: reward / risk });
                return;
            }
        }

        // 3. Cooldown (database-backed = most reliable)
        const now = Date.now();
        if (this.opts.cooldownBackend === 'database') {
            const { lastTradeAt } = await dbService.getCoolDown(symbol); 

            if ((now - lastTradeAt) < this.opts.cooldownMs) {
                return;
            }
            // Update all matching alerts
            await dbService.upsertCoolDown(symbol, now);
        } else {
            if (now - (this.lastAlertAt[symbol] ?? 0) < this.opts.cooldownMs) return;
            this.lastAlertAt[symbol] = now;
        }

        // 4. Send Telegram alert
        await this.sendTelegramSignal(symbol, signal, price);

        // 5. Remember for deduplication
        this.lastSignal[symbol] = { signal, price };

        // 6. Simulate trade in background → get real outcome for ML training
        if (config.ml.trainingEnabled) {
            void this.simulateAndTrain(symbol, signal, price, primaryData, htf);
        }

        // === LIVE TRADING (if enabled) ===
        if (config.autoTrade) {
            void this.executeLiveTrade(symbol, signal, price, now);              // ← Fire-and-forget
        }
    }

    private async sendTelegramSignal(symbol: string, signal: TradeSignal, price: number): Promise<void> {
        const escape = (s: string) => s.replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
        const lines = [
            `**${signal.signal.toUpperCase()} SIGNAL**`,
            `**Symbol:** ${escape(symbol)}`,
            `**Price:** $${price.toFixed(8)}`,
            signal.confidence ? `**Confidence:** ${signal.confidence.toFixed(0)}%` : '',
            signal.stopLoss ? `**SL:** $${signal.stopLoss.toFixed(8)}` : '',
            signal.takeProfit ? `**TP:** $${signal.takeProfit.toFixed(8)} (≈${config.strategy.riskRewardTarget}R)` : '',
            signal.trailingStopDistance ? `**Trail:** $${signal.trailingStopDistance.toFixed(8)}` : '',
            `**Reasons:**`,
            ...signal.reason.map(r => `• ${escape(r)}`),
        ].filter(Boolean);

        await this.telegramService?.sendMessage(lines.join('\n'), { parse_mode: 'MarkdownV2' });
    }


    /**
 * Executes a live trade based on a signal
 * - Calculates position size from account balance
 * - Places market order with SL/TP/trailing
 * - Logs to DB
 * - Fires and forgets (non-blocking)
 */
    private async executeLiveTrade(
        symbol: string,
        signal: TradeSignal,
        currentPrice: number,
        timestamp: number = Date.now()
    ): Promise<void> {
        if (!config.autoTrade) return;

        try {
            // 1. Get current account balance (USDT equity)
            const balance = await this.exchangeService.getAccountBalance();
            if (!balance || balance <= 0) {
                logger.warn('Insufficient balance or failed fetch', { symbol, balance });
                return;
            }

            // 2. Calculate position size: % of total balance
            const riskAmountUsd = balance * (config.strategy.positionSizePercent / 100);
            const positionSizeBase = riskAmountUsd / currentPrice;

            // 3. Safety cap: never risk more than 10% on one trade
            const maxRiskUsd = balance * 0.10;
            const finalSize = Math.min(positionSizeBase, maxRiskUsd / currentPrice);

            if (finalSize < 0.0001) {
                logger.warn('Position size too small, skipping', { symbol, finalSize });
                return;
            }

            const side: 'buy' | 'sell' = signal.signal === 'buy' ? 'buy' : 'sell';

            logger.info('EXECUTING LIVE TRADE', {
                symbol,
                side: side.toUpperCase(),
                size: finalSize.toFixed(6),
                usdValue: (finalSize * currentPrice).toFixed(2),
                price: currentPrice.toFixed(8),
                leverage: config.strategy.leverage,
            });

            // 4. Place the actual order
            const order = await this.exchangeService.placeOrder(
                symbol,
                side,
                finalSize,
                signal.stopLoss ?? undefined,
                signal.takeProfit ?? undefined,
                signal.trailingStopDistance ?? undefined
            );

            // 5. Log to database
            await dbService.logTrade({
                symbol,
                side,
                amount: finalSize,
                price: currentPrice,
                timestamp,
                mode: 'live',
                orderId: order.id ?? 'unknown',
            });

            // 6. Notify Telegram
            await this.telegramService?.sendMessage(
                `*LIVE TRADE EXECUTED*\n` +
                `• Symbol: ${symbol}\n` +
                `• Side: ${side.toUpperCase()}\n` +
                `• Size: ${finalSize.toFixed(6)}\n` +
                `• Entry: $${currentPrice.toFixed(8)}\n` +
                `• SL: $${(signal.stopLoss || 0).toFixed(8)}\n` +
                `• TP: $${(signal.takeProfit || 0).toFixed(8)}`,
                { parse_mode: 'Markdown' }
            );

            logger.info('Live trade placed successfully', { symbol, orderId: order.id });

            // 7. Optional: monitor outcome for ML (fire-and-forget)
            if (config.ml.trainingEnabled) {
                void this.monitorLiveTradeOutcome(symbol, signal, finalSize, timestamp);
            }

        } catch (err) {
            const msg = `LIVE TRADE FAILED: ${symbol} ${(err as Error).message}`;
            logger.error(msg, { error: err });
            await this.telegramService?.sendMessage(`Trade execution failed: ${msg}`).catch(() => { });
        }
    }

    // ===========================================================================
    // SIMULATE TRADE → FEED INTO ML (5-TIER LABELING)
    // ===========================================================================
    private async simulateAndTrain(
        symbol: string,
        signal: TradeSignal,
        entryPrice: number,
        primaryData: OhlcvData,
        htfData: OhlcvData
    ): Promise<void> {
        try {
            const features = mlService.extractFeatures({
                symbol,
                primaryData,
                htfData,
                price: entryPrice,
                atrMultiplier: config.strategy.atrMultiplier,
                riskRewardTarget: config.strategy.riskRewardTarget,
                trailingStopPercent: config.strategy.trailingStopPercent,
            });

            // Run full simulation (handles SL, TP, trailing, partials, timeout)
            const result = await simulateTrade(this.exchangeService, symbol, signal, entryPrice);

            // Convert outcome into proper 5-tier label
            const label = this.calculateLabel(signal.signal, result.outcome, result.rMultiple);

            // Feed into ML system with full context
            await mlService.ingestSimulatedOutcome(
                symbol,
                features,
                label,
                result.rMultiple,
                result.pnl
            );

            logger.info('ML sample ingested from simulation', {
                symbol,
                side: signal.signal,
                outcome: result.outcome,
                rMultiple: result.rMultiple.toFixed(3),
                pnl: `${result.pnl.toFixed(2)}%`,
                label,
            });
        } catch (err) {
            logger.error('Simulation → ML failed', { symbol, error: err });
        }
    }

    /**
     * Monitors a trade's outcome for ML training.
     * - Tracks position until closed or timeout, then logs training sample.
     * @param symbol - Trading symbol.
     * @param signal - Trade signal used to open the trade.
     * @param amount - Trade amount (in base asset).
     * @param startTime - Timestamp when the trade was opened.
     * @private
     */
    private async monitorLiveTradeOutcome(
        symbol: string,
        signal: TradeSignal,
        amount: number,
        entryTime: number
    ): Promise<void> {
        const timeoutMs = 4 * 60 * 60 * 1000; // 4 hours max
        const pollInterval = 60_000;         // Check every minute

        try {
            while (Date.now() - entryTime < timeoutMs) {
                const positions = await this.exchangeService.getPositions(symbol);
                const position = positions.find((p: any) =>
                    p.symbol === symbol && p.side === (signal.signal === 'buy' ? 'long' : 'short')
                );

                if (!position || position.contracts === 0) {
                    // Position closed → fetch closed trades
                    const closed = await this.exchangeService.getClosedTrades(symbol, entryTime);
                    const match = closed.find((t: any) =>
                        Math.abs(t.amount - amount) < amount * 0.1 &&
                        t.timestamp >= entryTime
                    );

                    const realizedPnl = match?.amount ?? 0;
                    const pnlPercent = realizedPnl / (amount * (match?.price ?? 0)) * 100;

                    const label = realizedPnl > 0
                        ? (pnlPercent >= 3 ? 2 : 1)
                        : (pnlPercent <= -3 ? -2 : -1);

                    logger.info('Live trade closed → ML sample', {
                        symbol,
                        pnlPercent: pnlPercent.toFixed(2),
                        label,
                    });

                    // Optional: re-extract features at close time and ingest
                    // await mlService.ingestLiveOutcome(...)

                    return;
                }

                await new Promise(r => setTimeout(r, pollInterval));
            }

            // Timeout: force close
            const sideToClose = signal.signal === 'buy' ? 'sell' : 'buy';
            await this.exchangeService.placeOrder(symbol, sideToClose, amount);
            logger.warn('Live trade timed out → forced close', { symbol });
        } catch (err) {
            logger.error('Failed monitoring live trade', { symbol, error: err });
        }
    }


    /** Convert simulation result into -2 to +2 label */
    private calculateLabel(side: 'buy' | 'sell' | 'hold', outcome: string, r: number): SignalLabel {
        if (side === 'hold') return 0;
        if (outcome.includes('sl')) {
            return r <= -1.5 ? -2 : -1;
        }
        if (outcome.includes('tp')) {
            if (r >= 3.0) return 2;
            if (r >= 1.5) return 1;
            return 0;
        }
        return 0; // timeout or neutral
    }

    // ===========================================================================
    // CUSTOM ALERTS (user-defined conditions)
    // ===========================================================================
    private async checkCustomAlerts(): Promise<void> {
        const alerts = await dbService.getActiveAlerts();
        const now = Date.now();

        for (const alert of alerts) {
            if (this.opts.cooldownBackend === 'database' && alert.lastAlertAt && now - alert.lastAlertAt < this.opts.cooldownMs) {
                continue;
            }

            try {
                const data = await this.exchangeService.getOHLCV(alert.symbol, alert.timeframe || '1h');
                if (!data || data.closes.length < config.historyLength) continue;

                const { conditionsMet, reasons } = this.alertEvaluator.evaluate(data, alert.conditions);
                if (conditionsMet) {
                    const msg = [
                        `**Custom Alert Triggered**`,
                        `**Symbol:** ${alert.symbol} (${alert.timeframe})`,
                        `**Conditions:**`,
                        ...reasons.map(r => `• ${r}`),
                    ].join('\n');

                    await this.telegramService?.sendMessage(msg, { parse_mode: 'MarkdownV2' });
                    await dbService.setLastAlertTime(alert.id, now);
                    logger.info(`Custom alert ${alert.id} triggered`, { symbol: alert.symbol });
                }
            } catch (err) {
                logger.error(`Alert ${alert.id} failed`, { error: err });
            }
        }
    }

    // ===========================================================================
    // UTILITY: Retry wrapper
    // ===========================================================================
    /**
    * Executes a function with retries on failure.
    * @param fn - Function to execute.
    * @param retries - Number of retries.
    * @returns Result of the function.
    * @throws Last error if all retries fail.
    * @private
    */
    private async withRetries<T>(fn: () => Promise<T>, retries: number): Promise<T> {
        let lastErr: unknown;
        for (let i = 0; i <= retries; i++) {
            try {
                return await fn();
            } catch (err) {
                lastErr = err;
                if (i < retries) {
                    const delay = 300 * (i + 1);
                    logger.warn(`Retry ${i + 1}/${retries} after error`, { error: (err as Error).message });
                    await new Promise(r => setTimeout(r, delay));
                }
            }
        }
        throw lastErr;
    }
}
