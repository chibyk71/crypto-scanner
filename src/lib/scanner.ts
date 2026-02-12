// src/lib/scanner.ts
// =============================================================================
// MARKET SCANNER – CORE ENGINE OF THE ENTIRE TRADING BOT
//
// Purpose:
//   • Orchestrates the full trading pipeline on every scan cycle
//   • Fetches market data → generates signals → simulates outcomes → trains ML
//   • Sends Telegram alerts and executes live trades via AutoTradeService
//   • Evaluates custom user alerts
//   • Runs either periodically (production) or once (testing/debugging)
//
// Key Features:
//   • Highly concurrent symbol processing with jitter to avoid rate limits
//   • Smart HTF (higher timeframe) caching to reduce API calls
//   • Robust cooldown and deduplication to prevent spam
//   • Integrated excursion insights in Telegram alerts
//   • Fire-and-forget simulation and live trading
//   • Comprehensive error handling and retry logic
//   • Heartbeat monitoring for operational visibility
// =============================================================================

import { ExchangeService } from './services/exchange';
import { dbService } from './db';
import { Strategy } from './strategy';
import { AutoTradeService } from './services/autoTradeService';        // ← Handles safe live execution with excursion filtering
import { createLogger } from './logger';
import { config } from './config/settings';
import type { OhlcvData } from '../types';
import { AlertEvaluatorService } from './services/alertEvaluator';
import type { TelegramBotController } from './services/telegramBotController';
import { simulateTrade } from './services/simulateTrade';
import { cooldownService } from './services/cooldownService';

const logger = createLogger('MarketScanner');

/** Supported running modes */
type ScannerMode = 'single' | 'periodic';

/** Cooldown storage backend – database is more reliable across restarts */
type CooldownBackend = 'database' | 'memory';

/** Cached higher-timeframe data to avoid redundant API calls */
interface CachedHtf {
    data: OhlcvData;
    lastCloseTime: number;      // Timestamp when last HTF candle closed
    lastFetchTime: number;      // When we last fetched fresh data
}

/** Configuration options for scanner behavior */
type ScannerOptions = {
    mode?: ScannerMode;
    intervalMs?: number;
    concurrency?: number;
    jitterMs?: number;
    retries?: number;
    heartbeatCycles?: number;
    requireAtrFeasibility?: boolean;
    cooldownBackend?: CooldownBackend;
};

/**
 * MarketScanner – The beating heart of the bot
 *
 * Responsibilities:
 *   • Coordinate all symbols in parallel
 *   • Manage scan lifecycle (periodic or single-run)
 *   • Handle signal deduplication and cooldown
 *   • Trigger simulations, ML training, alerts, and live trading
 *   • Provide operational monitoring (heartbeat)
 */
export class MarketScanner {
    // Runtime state flags
    private running = false;           // Is the scanner active?
    private isScanning = false;        // Is a scan cycle currently in progress?
    private scanTimer: NodeJS.Timeout | null = null;
    private scanCount = 0;             // Local counter when not using DB heartbeat

    // Higher-timeframe cache – reduces API load dramatically
    private htfCache: Record<string, CachedHtf> = {};

    // Evaluates custom user-defined alerts
    private alertEvaluator = new AlertEvaluatorService();

    // Final resolved configuration with defaults applied
    private readonly opts: Required<ScannerOptions>;

    // Dedicated service for safe, excursion-aware live trading
    private readonly autoTradeService: AutoTradeService;

    /**
     * Initializes the MarketScanner with all required dependencies.
     *
     * @param exchangeService - Handles market data and order execution
     * @param telegramService - Optional: for sending alerts and status updates
     * @param strategy - Core signal generation logic
     * @param symbols - List of trading pairs to monitor
     * @param opts - Optional overrides for scanner behavior
     */
    constructor(
        private readonly exchangeService: ExchangeService,
        private readonly telegramService: TelegramBotController | undefined,
        private readonly strategy: Strategy,
        private readonly symbols: string[],
        opts: ScannerOptions = {}
    ) {
        this.opts = {
            mode: 'periodic',
            intervalMs: config.scanner.scanIntervalMs ?? 60_000,
            concurrency: 4,
            jitterMs: 300,
            retries: 3,
            heartbeatCycles: config.scanner.heartBeatInterval ?? 60,
            requireAtrFeasibility: true,
            cooldownBackend: 'database',
            ...opts,
        };

        // ← Initialize AutoTradeService with exchange and db
        this.autoTradeService = new AutoTradeService(this.exchangeService, telegramService);

        logger.info(`MarketScanner initialized for ${symbols.length} symbols`, {
            mode: this.opts.mode,
            symbols,
            intervalSec: this.opts.intervalMs / 1000,
        });
    }

    // =========================================================================
    // PUBLIC CONTROL: Start the scanner (periodic or single-run mode)
    // =========================================================================
    /**
     * Starts the MarketScanner in the configured mode.
     *
     * Called from:
     *   • Main application entry point (worker startup)
     *   • Manual restart commands
     *
     * Behavior:
     *   • Prevents duplicate starts
     *   • Clears OHLCV cache for fresh data
     *   • Periodic mode: runs immediately + sets interval timer
     *   • Single mode: runs once and stops
     *
     * Important:
     *   • First scan runs synchronously (await) to catch startup errors early
     */
    public async start(): Promise<void> {
        // Prevent starting multiple instances
        if (this.running) {
            logger.warn('Scanner already running');
            return;
        }
        this.running = true;

        // Clear any cached candle data – ensures fresh market view on (re)start
        this.exchangeService.clearCache();
        logger.info('OHLCV cache cleared on start');

        if (this.opts.mode === 'periodic') {
            // Run first scan immediately (synchronous) for fast feedback
            await this.scanAllSymbols();

            // Schedule recurring scans
            this.scanTimer = setInterval(() => void this.scanAllSymbols(), this.opts.intervalMs);
            logger.info(`Periodic scanning started every ${this.opts.intervalMs / 1000}s`);
        } else {
            // Single-run mode (useful for testing or one-off scans)
            await this.scanAllSymbols();
            this.running = false;
        }
    }

    // =========================================================================
    // PUBLIC CONTROL: Stop the scanner gracefully
    // =========================================================================
    /**
     * Stops the scanner and cleans up resources.
     *
     * Called from:
     *   • Graceful shutdown handlers (SIGTERM, /stopbot command)
     *   • End of single-run mode
     *
     * Behavior:
     *   • Clears interval timer
     *   • Sets running flag to false
     *   • Safe even if timer doesn't exist
     */
    public stop(): void {
        this.running = false;

        // Clear recurring scan timer if active
        if (this.scanTimer) {
            clearInterval(this.scanTimer);
            this.scanTimer = null;
        }

        logger.info('MarketScanner stopped');
    }

    // =========================================================================
    // MAIN SCAN CYCLE: Process all symbols in parallel
    // =========================================================================
    /**
     * Executes a full market scan cycle across all configured symbols.
     *
     * Responsibilities:
     *   • Prevent overlapping scans
     *   • Track cycle count (via DB heartbeat or local counter)
     *   • Launch concurrent workers for speed
     *   • Evaluate custom alerts after data refresh
     *   • Send periodic heartbeat messages
     *   • Comprehensive error handling with Telegram notification
     *
     * @private – called by timer or start()
     */
    private async scanAllSymbols(): Promise<void> {
        // Prevent concurrent scans (race condition protection)
        if (this.isScanning) {
            logger.warn('Previous scan still running – skipping');
            return;
        }
        this.isScanning = true;

        const start = Date.now();

        // Get current cycle number – DB for persistence, local for testing
        const cycle = this.opts.cooldownBackend === 'database'
            ? await dbService.incrementHeartbeatCount()
            : ++this.scanCount;

        logger.info(`Scan cycle #${cycle} started`, { symbols: this.symbols.length });

        try {
            // Create work queue and launch concurrent workers
            const queue = [...this.symbols];
            const workers = Array.from(
                { length: Math.min(this.opts.concurrency, queue.length) },
                () => this.processWorker(queue)
            );
            await Promise.all(workers);

            // Evaluate user-defined custom alerts with fresh data
            await this.checkCustomAlerts();

            // Periodic heartbeat for monitoring (every N cycles)
            if (cycle % this.opts.heartbeatCycles === 0) {
                const duration = Date.now() - start;
                const msg = `Heartbeat: Scan #${cycle} completed in ${duration}ms | ${this.symbols.length} symbols`;
                await this.telegramService?.sendMessage(msg);
                logger.info(msg);
            }
        } catch (err) {
            // Critical error – entire cycle failed
            logger.error('Scan cycle crashed', { error: err });
            await this.telegramService?.sendMessage(`Scan failed: ${(err as Error).message}`);
        } finally {
            // Always reset flag – prevents permanent lock on crash
            this.isScanning = false;
            logger.info(`Scan cycle #${cycle} finished in ${Date.now() - start}ms`);
        }
    }

    // =========================================================================
    // WORKER POOL: Process symbols concurrently from shared queue
    // =========================================================================
    /**
     * Worker function that pulls symbols from queue and processes them.
     *
     * Design:
     *   • Multiple workers run in parallel (controlled by concurrency option)
     *   • Shared queue ensures even distribution
     *   • Jitter delay spreads API requests to avoid rate limits
     *   • Wrapped in retry logic for resilience
     *
     * @param queue - Shared array of remaining symbols
     * @private
     */
    private async processWorker(queue: string[]): Promise<void> {
        // Continue until queue is empty
        while (queue.length) {
            const symbol = queue.shift();
            if (!symbol) break;

            // Random jitter to avoid thundering herd on exchange API
            if (this.opts.jitterMs > 0) {
                await new Promise(r => setTimeout(r, Math.random() * this.opts.jitterMs));
            }

            // Process with retry wrapper for transient errors
            await this.withRetries(() => this.processSymbol(symbol), this.opts.retries);
        }
    }

    /**
 * Processes ONE trading symbol from start to finish during a single scan cycle.
 *
 * 2026+ DESIGN PHILOSOPHY – Pure Orchestrator Role:
 *   - MarketScanner only coordinates:
 *       1. Cooldown check
 *       2. Data fetch (primary + HTF)
 *       3. Raw technical signal generation (Strategy – no regime/excursion logic)
 *       4. Background simulation trigger (if buy/sell)
 *       5. Forward raw signal to AutoTradeService (no early filtering)
 *   - All regime-based decisions, filtering, alerting, SL/TP adjustment, execution
 *     are centralized in AutoTradeService.
 *   - Benefits:
 *       - No duplicated logic
 *       - Simulations always run on clean base signals → unbiased excursion data
 *       - Scanner stays lightweight and fast
 *       - One failure never blocks the entire cycle
 *
 * Strict order of responsibilities:
 *   1. Cooldown check → early exit if throttled
 *   2. Fetch primary + HTF data
 *   3. Generate raw TradeSignal (base SL/TP)
 *   4. Trigger background simulation (fire-and-forget, only for buy/sell)
 *   5. Forward raw signal to AutoTradeService (even 'hold')
 *   6. Graceful per-symbol error handling
 */
    private async processSymbol(symbol: string): Promise<void> {
        const correlationId = crypto.randomUUID().slice(0, 8); // short traceable ID
        const startMs = Date.now();

        try {
            // 1. Early Cooldown Check – skip expensive work if throttled
            if (await cooldownService.isActive(symbol)) {
                logger.debug(`[${correlationId}] ${symbol} on cooldown – skipping`);
                return;
            }

            logger.debug(`[${correlationId}] Processing ${symbol}`);

            // 2. Fetch primary timeframe data (fast, main indicator source)
            const primaryData = await this.getPrimaryData(symbol);
            if (!primaryData || primaryData.closes.length < config.historyLength) {
                logger.debug(`[${correlationId}] Insufficient primary data for ${symbol} – skipping`);
                return;
            }

            // 3. Fetch higher timeframe data (trend filter, aggressively cached)
            const htfData = await this.getHtfData(symbol);
            if (!htfData || htfData.closes.length < config.historyLength) {
                logger.debug(`[${correlationId}] Insufficient HTF data for ${symbol} – skipping`);
                return;
            }

            const currentPrice = primaryData.closes.at(-1)!;

            // 4. Generate raw technical signal (base SL/TP, no regime filtering)
            const signal = await this.strategy.generateSignal({
                symbol,
                primaryData,
                htfData,
                price: currentPrice,
                atrMultiplier: config.strategy.atrMultiplier,
                riskRewardTarget: config.strategy.riskRewardTarget,
                trailingStopPercent: config.strategy.trailingStopPercent,
            });

            // Quick console visibility (useful during dev/tuning)
            console.log(
                `[${correlationId}] [Signal] ${symbol}: ${signal.signal.toUpperCase()} ` +
                `(Conf: ${signal.confidence.toFixed(1)}%) ` +
                (signal.stopLoss ? `SL: ${signal.stopLoss.toFixed(6)} ` : '') +
                (signal.takeProfit ? `TP: ${signal.takeProfit.toFixed(6)}` : '')
            );

            // 5. Trigger background simulation (only for actionable signals)
            if (signal.signal !== 'hold') {
                if (!Array.isArray(signal.features) || signal.features.length === 0) {
                    logger.warn(`[${correlationId}] Invalid/empty features – skipping simulation for ${symbol}`);
                } else {
                    logger.info(`[${correlationId}] Triggering background simulation: ${symbol} → ${signal.signal.toUpperCase()} @ ${currentPrice.toFixed(6)}`);

                    // Fire-and-forget: simulateTrade stores everything (features + label + metrics)
                    void simulateTrade(
                        this.exchangeService,
                        symbol,
                        signal,
                        currentPrice,
                        signal.features
                    ).catch(err => {
                        logger.error(`[${correlationId}] Background simulation failed`, {
                            symbol,
                            side: signal.signal,
                            error: err instanceof Error ? err.message : String(err),
                            stack: err instanceof Error ? err.stack : undefined,
                            durationSec: ((Date.now() - startMs) / 1000).toFixed(1),
                        });
                    });
                }

                cooldownService.setCooldown(symbol).catch(err => {
                    logger.error(`[${correlationId}] Failed to set cooldown`, {
                        symbol,
                        error: err instanceof Error ? err.message : String(err),
                        stack: err instanceof Error ? err.stack : undefined,
                    });
                });
            } else {
                logger.debug(`[${correlationId}] Signal is HOLD – no simulation for ${symbol}`);
            }

            // 6. ALWAYS forward raw signal to AutoTradeService
            //    → AutoTradeService decides filtering, alerting, execution
            logger.debug(`[${correlationId}] Forwarding raw signal to AutoTradeService: ${symbol} → ${signal.signal.toUpperCase()}`);
            void this.autoTradeService.execute(signal);

        } catch (err) {
            const durationSec = ((Date.now() - startMs) / 1000).toFixed(1);

            logger.error(`[${correlationId}] Failed processing ${symbol}`, {
                phase: 'processSymbol',
                error: err instanceof Error ? err.message : String(err),
                stack: err instanceof Error ? err.stack : undefined,
                durationSec,
            });

            // Never rethrow — other symbols must continue
        }
    }

    // =========================================================================
    // DATA FETCHING: Primary timeframe (fast) OHLCV
    // =========================================================================
    /**
     * Gets primary timeframe data with preference for in-memory live cache.
     *
     * Priority:
     *   1. Use live in-memory cache if sufficient length
     *   2. Fallback to fresh API fetch
     *
     * @param symbol - Trading pair
     * @returns OhlcvData or null if insufficient
     */
    private async getPrimaryData(symbol: string): Promise<OhlcvData | null> {
        // Try fast path: live cache (updated in real-time by exchange service)
        const live = this.exchangeService.getPrimaryOhlcvData(symbol);
        if (live && live.length >= config.historyLength) {
            // Slice to required length and convert format
            return this.exchangeService.toOhlcvData(live.slice(-config.historyLength), symbol);
        }

        // Slow path: fetch fresh from exchange API
        return await this.exchangeService.getOHLCV(
            symbol,
            config.scanner.primaryTimeframe,
            undefined,
            undefined,
            true  // Force fresh fetch
        );
    }

    // =========================================================================
    // DATA FETCHING: Higher timeframe (HTF) with smart caching
    // =========================================================================
    /**
     * Gets HTF data with aggressive caching to minimize API calls.
     *
     * Caching logic:
     *   • Refresh when new HTF candle closes
     *   • Refresh if >5 minutes old (stale safety)
     *   • Stores last close time and fetch time
     *
     * Dramatically reduces load on exchange API
     *
     * @param symbol - Trading pair
     * @returns OhlcvData or null
     */
    private async getHtfData(symbol: string): Promise<OhlcvData | null> {
        const tf = config.scanner.htfTimeframe;
        const ms = ExchangeService.toTimeframeMs(tf);           // e.g., 1h = 3600000 ms
        const now = Date.now();
        const currentCandleStart = Math.floor(now / ms) * ms;    // Start of current HTF candle

        const cached = this.htfCache[symbol];

        // Refresh conditions:
        //   • No cache yet
        //   • New HTF candle has closed
        //   • Cache older than 5 minutes (safety)
        const shouldRefresh =
            !cached ||
            cached.lastCloseTime < currentCandleStart ||
            now - cached.lastFetchTime > 5 * 60_000;

        if (shouldRefresh) {
            // Fetch fresh HTF data
            const data = await this.exchangeService.getOHLCV(symbol, tf, undefined, undefined, true);
            if (data && data.closes.length >= config.historyLength) {
                // Update cache with new data and timestamps
                this.htfCache[symbol] = {
                    data,
                    lastCloseTime: data.timestamps.at(-1)!,  // Most recent closed candle
                    lastFetchTime: now,
                };
                logger.debug(`HTF refreshed: ${symbol} ${tf}`);
            }
            return data ?? null;
        }

        // Return cached data (fast path)
        return cached.data;
    }

    // =========================================================================
    // CUSTOM ALERTS: Evaluate user-defined conditions
    // =========================================================================
    /**
     * Checks all active custom alerts against current market data.
     *
     * Called from:
     *   • scanAllSymbols() – after processing all symbols
     *
     * Behavior:
     *   • Respects per-alert cooldown
     *   • Fetches fresh data for each alert's symbol/timeframe
     *   • Evaluates conditions via AlertEvaluatorService
     *   • Sends Telegram notification on trigger
     *   • Updates lastAlertAt for throttling
     */
    private async checkCustomAlerts(): Promise<void> {
        const alerts = await dbService.getActiveAlerts();
        const now = Date.now();

        // Process each alert independently
        for (const alert of alerts) {
            try {
                // Fetch data for alert's specific symbol and timeframe
                const data = await this.exchangeService.getOHLCV(alert.symbol, alert.timeframe || '1h');
                if (!data || data.closes.length < config.historyLength) continue;

                // Evaluate user-defined conditions
                const { conditionsMet, reasons } = this.alertEvaluator.evaluate(data, alert.conditions);

                if (conditionsMet) {
                    // Build and send trigger message
                    const msg = [
                        `**Custom Alert Triggered**`,
                        `**Symbol:** ${alert.symbol} (${alert.timeframe})`,
                        `**Conditions:**`,
                        ...reasons.map(r => `• ${r}`),
                    ].join('\n');

                    await this.telegramService?.sendMessage(msg, { parse_mode: 'MarkdownV2' });

                    // Update cooldown timestamp
                    await dbService.setLastAlertTime(alert.id, now);

                    logger.info(`Custom alert ${alert.id} triggered`, { symbol: alert.symbol });
                }
            } catch (err) {
                // Individual alert failure – log but continue with others
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
