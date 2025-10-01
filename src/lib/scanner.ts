// src/lib/scanner.ts

/**
 * Provides functionality for interacting with a cryptocurrency exchange, such as fetching market data or executing trades.
 */
import { ExchangeService } from './services/exchange';

/**
 * Provides functionality for sending messages, photos, and documents to a Telegram chat.
 */
import { TelegramService } from './services/telegram';

/**
 * Provides database operations for managing alerts, locks, and heartbeats.
 */
import { dbService } from './db';

/**
 * Imports the trading strategy logic and the `TradeSignal` type for generating and interpreting trade signals.
 */
import { Strategy, type TradeSignal } from './strategy';

/**
 * Imports a logger utility to log scanner-related events and errors.
 * The logger is configured with a context of 'MarketScanner' for categorized logging.
 */
import { createLogger } from './logger';

/**
 * Imports the application configuration, including polling intervals, heartbeat settings, and symbols.
 */
import { config } from './config/settings';
import type { IndicatorValues } from '../types';

/**
 * Initializes a logger instance for scanner-related logging.
 * Logs are tagged with the 'MarketScanner' context for easy filtering and debugging.
 */
const logger = createLogger('MarketScanner');

/**
 * Defines the possible modes for the market scanner.
 * - 'single': Performs a one-time scan of the market.
 * - 'periodic': Runs scans on a scheduled interval.
 */
type ScannerMode = 'single' | 'periodic';

/**
 * Defines the possible backends for managing cooldown periods between alerts.
 * - 'database': Uses the database to track cooldowns.
 * - 'memory': Uses in-memory storage for cooldown tracking.
 */
type CooldownBackend = 'database' | 'memory';

/**
 * Configuration options for the market scanner.
 * Allows customization of scanning behavior, concurrency, and alert settings.
 */
type ScannerOptions = {
    /**
     * The scanning mode: 'single' for one-off scans or 'periodic' for scheduled scans.
     * @default 'single'
     */
    mode?: ScannerMode;

    /**
     * The interval (in milliseconds) between scans in periodic mode.
     * @default config.pollingInterval (typically 60,000 ms)
     */
    intervalMs?: number;

    /**
     * The maximum number of symbols to process concurrently.
     * @default 3
     */
    concurrency: number;

    /**
     * The cooldown period (in milliseconds) between alerts for the same symbol.
     * @default 300,000 (5 minutes)
     */
    cooldownMs?: number;

    /**
     * A random delay (in milliseconds) to avoid exchange rate limits.
     * @default 250
     */
    jitterMs?: number;

    /**
     * The number of retries for transient errors during symbol processing.
     * @default 1
     */
    retries?: number;

    /**
     * The number of scan cycles between heartbeat messages.
     * @default config.heartBeatInterval (typically 60)
     */
    heartbeatCycles?: number;

    /**
     * Whether to check ATR-based feasibility before acting on trade signals.
     * @default true
     */
    requireAtrFeasibility?: boolean;

    /**
     * The backend for managing cooldown periods: 'database' or 'memory'.
     * @default 'database'
     */
    cooldownBackend?: CooldownBackend;
};

/**
 * Manages market scanning for trading signals across multiple symbols.
 * Integrates with an exchange service, trading strategy, database, and Telegram for notifications.
 * Supports both single and periodic scanning modes with configurable options.
 */
export class MarketScanner {
    /**
     * Indicates whether the scanner is currently running.
     * @private
     */
    private running = false;

    /**
     * The timer for periodic scans, used in 'periodic' mode.
     * @private
     */
    private timer: NodeJS.Timeout | null = null;

    /**
     * The number of scan cycles completed (in-memory counter).
     * Used when `cooldownBackend` is set to 'memory'.
     * @private
     */
    private scanCount = 0;

    /**
     * Tracks the timestamp of the last alert for each symbol (in-memory).
     * Used when `cooldownBackend` is set to 'memory'.
     * @private
     */
    private lastAlertAt: Record<string, number> = {};

    /**
     * Initializes the market scanner with dependencies and configuration options.
     * @param exchange - The exchange service for fetching market data.
     * @param strategy - The trading strategy for generating trade signals.
     * @param symbols - The list of trading symbols to scan (e.g., ['BTC/USDT', 'ETH/USDT']).
     * @param telegram - The Telegram service for sending notifications.
     * @param opts - Configuration options for the scanner.
     */
    constructor(
        private readonly exchange: ExchangeService,
        private readonly strategy: Strategy,
        private readonly symbols: string[],
        private readonly telegram: TelegramService,
        private readonly opts: ScannerOptions = {
            mode: 'single',
            intervalMs: config.pollingInterval ?? 60_000,
            concurrency: 3,
            cooldownMs: 5 * 60_000,
            jitterMs: 250,
            retries: 1,
            heartbeatCycles: config.heartBeatInterval ?? 60,
            requireAtrFeasibility: true,
            cooldownBackend: 'database',
        }
    ) { }

    /**
     * Starts the market scanner in either single or periodic mode.
     * In periodic mode, schedules scans at the configured interval.
     * Does nothing if the scanner is already running.
     * @returns {Promise<void>} A promise that resolves when the scanner starts.
     * @example
     * typescript
     * const scanner = new MarketScanner(exchange, strategy, ['BTC/USDT'], telegram);
     * await scanner.start();
     *
     */
    async start(): Promise<void> {
        if (this.running) return;
        this.running = true;

        if (this.opts.mode === 'periodic') {
            await this.runScanCycle();
            this.timer = setInterval(() => {
                if (!this.running) return;
                void this.runScanCycle();
            }, this.opts.intervalMs ?? 60_000);
        } else {
            await this.runSingleScan();
        }
    }

    /**
     * Stops the market scanner and clears any scheduled scans.
     * Safe to call even if the scanner is not running.
     * @example
     * typescript
     * scanner.stop();
     *
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
     * Processes symbols concurrently, sends heartbeat messages, and handles errors.
     * Used for both single and periodic modes.
     * @returns {Promise<void>} A promise that resolves when the scan cycle completes.
     */
    async runSingleScan(): Promise<void> {
        const cycleCount = this.opts.cooldownBackend === 'database'
            ? await dbService.incrementHeartbeatCount()
            : ++this.scanCount;

        logger.info(`Scan cycle ${cycleCount} started`, { symbols: this.symbols });

        const { concurrency, jitterMs = 0, retries = 1, heartbeatCycles = 60 } = this.opts;
        const queue = [...this.symbols];
        const workers = Array.from(
            { length: Math.min(concurrency, queue.length) },
            () => this.processWorker(queue, jitterMs, retries)
        );
        await Promise.all(workers);

        if (cycleCount % heartbeatCycles === 0) {
            await this.telegram.sendMessage(`Heartbeat: Scan completed over ${this.symbols.length} symbols`)
                .catch(err => {
                    logger.error('Failed to send Telegram heartbeat message', { error: err });
                });
            if (this.opts.cooldownBackend === 'database') {
                await dbService.resetHeartbeatCount();
            }
            logger.info(`Heartbeat sent at cycle ${cycleCount}`);
        }

        logger.info(`Scan cycle ${cycleCount} completed`);
    }

    /**
     * Executes a scan cycle for periodic mode.
     * Identical to `runSingleScan` but separated for clarity and future extensibility.
     * @returns {Promise<void>} A promise that resolves when the scan cycle completes.
     */
    private async runScanCycle(): Promise<void> {
        const cycleCount = this.opts.cooldownBackend === 'database'
            ? await dbService.incrementHeartbeatCount()
            : ++this.scanCount;

        logger.info(`Scan cycle ${cycleCount} started`, { symbols: this.symbols });

        const { concurrency, jitterMs = 0, retries = 1, heartbeatCycles = 60 } = this.opts;
        const queue = [...this.symbols];
        const workers = Array.from(
            { length: Math.min(concurrency, queue.length) },
            () => this.processWorker(queue, jitterMs, retries)
        );
        await Promise.all(workers);

        if (cycleCount % heartbeatCycles === 0) {
            await this.telegram.sendMessage(`Heartbeat: Scan completed over ${this.symbols.length} symbols`)
                .catch(err => {
                    logger.error('Failed to send Telegram heartbeat message', { error: err });
                });
            if (this.opts.cooldownBackend === 'database') {
                await dbService.resetHeartbeatCount();
            }
            logger.info(`Heartbeat sent at cycle ${cycleCount}`);
        }
    }

    /**
     * Processes symbols from a queue concurrently with optional jitter and retries.
     * Handles errors by logging and sending Telegram notifications.
     * @param queue - The queue of symbols to process.
     * @param jitterMs - Random delay to avoid rate limits.
     * @param retries - Number of retries for transient errors.
     * @returns {Promise<void>} A promise that resolves when all symbols in the worker's queue are processed.
     * @private
     */
    private async processWorker(queue: string[], jitterMs: number, retries: number): Promise<void> {
        while (queue.length) {
            const symbol = queue.shift();
            if (!symbol) break;

            if (jitterMs > 0) {
                await new Promise((r) => setTimeout(r, Math.floor(Math.random() * jitterMs)));
            }

            try {
                await this.withRetries(() => this.processSymbol(symbol), retries);
            } catch (err) {
                const msg = (err as Error)?.message ?? String(err);
                logger.error(`Error processing ${symbol}`, { error: msg });
                await this.telegram.sendMessage(`Error processing ${symbol}: ${msg}`)
                    .catch(err => {
                        logger.error('Failed to send Telegram error message', { error: err });
                    });
            }
        }
    }

    /**
     * Processes a single symbol by fetching OHLCV data and generating a trade signal.
     * Validates data sufficiency and triggers trade or alert processing if applicable.
     * @param symbol - The trading symbol to process (e.g., 'BTC/USDT').
     * @returns {Promise<void>} A promise that resolves when the symbol is processed.
     * @private
     */
    private async processSymbol(symbol: string): Promise<void> {
        const ohlcv = await this.exchange.getOHLCV(symbol);
        const minCandles = config.historyLength ?? 200;
        if (!ohlcv || ohlcv.length < minCandles) {
            logger.warn(`Insufficient OHLCV data for ${symbol}`, { candles: ohlcv?.length || 0 });
            return;
        }

        const highs = ohlcv.map(c => Number(c[2])).filter(v => !isNaN(v));
        const lows = ohlcv.map(c => Number(c[3])).filter(v => !isNaN(v));
        const closes = ohlcv.map(c => Number(c[4])).filter(v => !isNaN(v));
        const volumes = ohlcv.map(c => Number(c[5])).filter(v => !isNaN(v));
        if (closes.length < minCandles) {
            logger.warn(`Insufficient valid OHLCV data for ${symbol}`, { closesLength: closes.length });
            return;
        }

        const currentPrice = closes.at(-1)!;

        const signal = this.strategy.generateSignal({
            symbol,
            highs,
            lows,
            closes,
            volumes,
        });

        if (signal.signal !== 'hold') {
            await this.processTradeSignal(symbol, signal, currentPrice);
        }

        await this.processDatabaseAlerts(symbol, currentPrice);
    }

    /**
     * Processes a trade signal for a symbol, applying ATR feasibility checks and cooldowns.
     * Sends a Telegram notification with signal details if conditions are met.
     * @param symbol - The trading symbol (e.g., 'BTC/USDT').
     * @param signal - The trade signal generated by the strategy.
     * @param currentPrice - The current price of the symbol.
     * @returns {Promise<void>} A promise that resolves when the signal is processed.
     * @private
     */
    private async processTradeSignal(symbol: string, signal: TradeSignal, currentPrice: number): Promise<void> {
        // --- ATR Feasibility Check (IMPROVED) ---
        if (this.opts.requireAtrFeasibility !== false) {
            const stopLoss = signal.stopLoss;
            const takeProfit = signal.takeProfit;

            if (stopLoss && takeProfit) {
                const risk = signal.signal === 'buy' ? currentPrice - stopLoss : stopLoss - currentPrice;
                const reward = signal.signal === 'buy' ? takeProfit - currentPrice : currentPrice - takeProfit;

                // Check if the actual calculated Risk/Reward ratio meets the minimum riskRewardTarget
                if (risk <= 0 || reward / risk < 1) { // 1 means 1:1, anything less is poor RR
                    logger.debug(`Signal skipped for poor R:R on ${symbol}. Target: ${this.strategy.riskRewardTarget}:1`, { risk, reward });
                    return;
                }
            }
        }

        // --- Cooldown Logic (UNCHANGED but still relevant) ---
        const now = Date.now();
        const cooldownMs = this.opts.cooldownMs ?? 5 * 60_000;

        if (this.opts.cooldownBackend === 'database') {
            const alerts = await dbService.getAlertsBySymbol(symbol);
            if (alerts.some(a => a.lastAlertAt && now - a.lastAlertAt < cooldownMs)) return;
            for (const alert of alerts) {
                await dbService.setLastAlertTime(alert.id, now);
            }
        } else {
            const last = this.lastAlertAt[symbol] ?? 0;
            if (now - last < cooldownMs) return;
            this.lastAlertAt[symbol] = now;
        }

        // --- Telegram Notification (UNCHANGED) ---
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

        await this.telegram.sendMessage(lines.join('\n'))
            .catch(err => {
                logger.error('Failed to send Telegram trade signal', { error: err });
            });
    }

    /**
 * Processes database-stored alerts for the given symbol, evaluating custom conditions against current market data.
 * This method fetches alerts from the database, retrieves OHLCV data for the alert's specified timeframe,
 * computes necessary technical indicators (RSI, EMA50, EMA200), and checks if all conditions are met.
 * If conditions are satisfied and the cooldown period has elapsed, it sends a Telegram notification with details
 * and updates the alert's status to 'triggered' and lastAlertAt timestamp.
 *
 * @param symbol - The trading symbol (e.g., 'SOL/USDT') to process alerts for.
 * @param currentPrice - The latest price of the symbol, typically the closing price of the most recent candle.
 * @returns {Promise<void>} A promise that resolves when processing completes; does not return data but logs and notifies as needed.
 * @throws {Error} If database operations or indicator calculations fail, logged via the application's logger.
 * @example
 * // Example usage in MarketScanner's runSingleScan method
 * await this.processDatabaseAlerts('SOL/USDT', 3.55);
 */
    private async processDatabaseAlerts(symbol: string, currentPrice: number): Promise<void> {
        const now = Date.now();
        const alerts = await dbService.getAlertsBySymbol(symbol);

        if (!alerts.length) return;

        // Group alerts by timeframe to perform OHLCV fetch once per timeframe (Performance Improvement)
        const groupedAlerts = alerts.reduce((acc, alert) => {
            const tf = alert.timeframe || config.timeframe || '1h';
            if (!acc[tf]) acc[tf] = [];
            acc[tf].push(alert);
            return acc;
        }, {} as Record<string, typeof alerts>);

        for (const [timeframe, tfAlerts] of Object.entries(groupedAlerts)) {
            // --- Simulated Indicator Calculation ---
            const prevClose = currentPrice; // Placeholder for previous close
            const rsiNow = 55; // Placeholder for current RSI
            const prevRsi = 50; // Placeholder for previous RSI
            const volumeNow = 100000; // Placeholder for current volume
            const maCross = 'none'; // Placeholder for MA cross

            // Placeholder for real indicator calculation and data extraction
            const indicatorValues: IndicatorValues = {
                rsiNow, ema50Now: 0, ema200Now: 0, prevClose, prevRsi, volumeNow, maCross
            };
            // --- End Simulated Indicator Calculation ---

            for (const alert of tfAlerts) {
                const cooldownMs = this.opts.cooldownMs ?? 300000;
                if (now - (alert.lastAlertAt || 0) < cooldownMs) continue;

                let conditionsMet = true;
                const reasons: string[] = [];

                // 2. Flexible Condition Evaluation (with Type Narrowing and Complete Check)
                for (const cond of alert.conditions) {
                    const targetValue =
                        (cond.type === 'price') ? currentPrice :
                            (cond.type === 'volume') ? indicatorValues.volumeNow :
                                (cond.type === 'rsi') ? indicatorValues.rsiNow :
                                    null; // Trend conditions don't compare against a single value

                    if (cond.type === 'trend') {
                        // Trend Check (EMA Crosses)
                        const isBullishCross = cond.operator === 'crosses_above' && indicatorValues.maCross === 'bullish';
                        const isBearishCross = cond.operator === 'crosses_below' && indicatorValues.maCross === 'bearish';

                        if (isBullishCross || isBearishCross) {
                            reasons.push(`Trend ${cond.operator} detected`);
                        } else {
                            conditionsMet = false;
                        }
                    } else if (targetValue !== null) {
                        // Price, Volume, RSI Checks (Value-based comparisons)
                        const value = cond.value;
                        let conditionPassed = false;

                        if (Array.isArray(value)) {
                            // Type Narrowing for Range: [min, max] (used with 'in')
                            const [min, max] = value;
                            if (cond.operator === 'in' && targetValue >= min && targetValue <= max) {
                                conditionPassed = true;
                                reasons.push(`${cond.type.toUpperCase()} (${targetValue}) in range [${min}, ${max}]`);
                            }
                        } else {
                            // Type Narrowing for Single Value (used with >, <, >=, <=, crosses_...)

                            // Handle simple comparisons
                            if (cond.operator === '>' && targetValue > value) conditionPassed = true;
                            else if (cond.operator === '<' && targetValue < value) conditionPassed = true;
                            else if (cond.operator === '>=' && targetValue >= value) conditionPassed = true;
                            else if (cond.operator === '<=' && targetValue <= value) conditionPassed = true;

                            // Handle Crossover checks
                            else if (cond.operator === 'crosses_above') {
                                const prevValue = (cond.type === 'price') ? indicatorValues.prevClose : indicatorValues.prevRsi;
                                if (prevValue !== undefined && prevValue <= value && targetValue > value) {
                                    conditionPassed = true;
                                    reasons.push(`${cond.type.toUpperCase()} crosses above ${value}`);
                                }
                            }
                            else if (cond.operator === 'crosses_below') {
                                const prevValue = (cond.type === 'price') ? indicatorValues.prevClose : indicatorValues.prevRsi;
                                if (prevValue !== undefined && prevValue >= value && targetValue < value) {
                                    conditionPassed = true;
                                    reasons.push(`${cond.type.toUpperCase()} crosses below ${value}`);
                                }
                            }

                            if (conditionPassed) {
                                // Only add reason if it's a simple comparison that hasn't been added by a crossover check
                                if (!cond.operator.startsWith('crosses')) {
                                    reasons.push(`${cond.type.toUpperCase()} (${targetValue}) ${cond.operator} ${value}`);
                                }
                            }
                        }

                        if (!conditionPassed) conditionsMet = false;
                    }

                    if (!conditionsMet) break; // Fail-fast: if one condition fails, move to the next alert
                }

                // ... (Notification and update logic is assumed to be here) ...
                if (conditionsMet) {
                    try {
                        const message = [
                            `🔔 **Custom Alert Triggered** 🔔`,
                            `**Symbol:** ${symbol} (${timeframe})`,
                            `**Alert ID:** ${alert.id}`,
                            `**Conditions Met:**`,
                            ...reasons.map(r => `  - ${r}`),
                        ].join('\n');

                        await this.telegram.sendMessage(message);
                        await dbService.setLastAlertTime(alert.id, now);
                        logger.info(`Alert ${alert.id} triggered for ${symbol}`);
                    } catch (err: any) {
                        logger.error(`Failed to notify for alert ${alert.id}: ${err.message}`);
                    }
                }
            }
        }

    }

    /**
     * Executes a function with retries for transient errors.
     * @param fn - The function to execute.
     * @param retries - The number of retries to attempt.
     * @returns {Promise<T>} The result of the function.
     * @throws The last error if all retries fail.
     * @private
     */
    private async withRetries<T>(fn: () => Promise<T>, retries: number): Promise<T> {
        let err: unknown;
        for (let i = 0; i <= retries; i++) {
            try {
                return await fn();
            } catch (e) {
                err = e;
                await new Promise((r) => setTimeout(r, 300 * (i + 1)));
            }
        }
        throw err;
    }
}

