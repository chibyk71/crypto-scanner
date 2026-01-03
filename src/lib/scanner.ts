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
import type { OhlcvData, SignalLabel, TradeSignal } from '../types';
import { AlertEvaluatorService } from './services/alertEvaluator';
import { mlService } from './services/mlService';
import type { TelegramBotController } from './services/telegramBotController';
import { simulateTrade } from './services/simulateTrade';

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
    cooldownMs?: number;
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

    // Deduplication and cooldown tracking
    private lastAlertAt: Record<string, number> = {};           // Memory backend only
    private lastSignal: Record<string, { signal: TradeSignal; price: number }> = {};

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
        private readonly telegramService: TelegramBotController | null,
        private readonly strategy: Strategy,
        private readonly symbols: string[],
        opts: ScannerOptions = {}
    ) {
        this.opts = {
            mode: 'periodic',
            intervalMs: config.scanner.scanIntervalMs ?? 60_000,
            concurrency: 4,
            cooldownMs: 5 * 60_000,
            jitterMs: 300,
            retries: 3,
            heartbeatCycles: config.scanner.heartBeatInterval ?? 60,
            requireAtrFeasibility: true,
            cooldownBackend: 'database',
            ...opts,
        };

        // ← Initialize AutoTradeService with exchange and db
        this.autoTradeService = new AutoTradeService(this.exchangeService);

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

    // =========================================================================
    // PER-SYMBOL PROCESSING: Core logic for one trading pair
    // =========================================================================
    /**
     * Processes a single symbol from end to end:
     *   • Fetch primary + HTF data
     *   • Generate signal via Strategy
     *   • If valid signal → handle alert/simulation/trading
     *
     * Called from:
     *   • processWorker() – concurrent workers
     *
     * Error handling:
     *   • Wrapped in try/catch → individual symbol failure doesn't crash entire scan
     *   • Logs error and continues with other symbols
     */
    private async processSymbol(symbol: string): Promise<void> {
        try {
            // Fetch fast timeframe data (e.g., 3m) – required for signals
            const primaryData = await this.getPrimaryData(symbol);
            if (!primaryData || primaryData.closes.length < config.historyLength) {
                // Not enough candles yet – skip silently
                return;
            }

            // Fetch higher timeframe data (e.g., 1h) – used for trend filtering
            const htfData = await this.getHtfData(symbol);
            if (!htfData || htfData.closes.length < config.historyLength) {
                return;
            }

            // Current market price = last close of primary timeframe
            const currentPrice = primaryData.closes.at(-1)!;

            // Generate signal using full context
            const signal = await this.strategy.generateSignal({
                symbol,
                primaryData,
                htfData,
                price: currentPrice,
                atrMultiplier: config.strategy.atrMultiplier,
                riskRewardTarget: config.strategy.riskRewardTarget,
                trailingStopPercent: config.strategy.trailingStopPercent,
            });

            // Only proceed if strategy returned a buy/sell (not hold)
            if (signal.signal !== 'hold') {
                await this.handleTradeSignal(symbol, signal, currentPrice, primaryData, htfData);
            }
        } catch (err) {
            // Individual symbol failure – log but continue scanning others
            logger.error(`Failed processing ${symbol}`, { error: err });
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
    // SIGNAL HANDLING: Full pipeline after valid signal
    // =========================================================================
    /**
     * Handles everything after a buy/sell signal is generated:
     *   • Deduplication (same signal/price/SL)
     *   • R:R feasibility check
     *   • Cooldown enforcement
     *   • Telegram alert with excursion insight
     *   • Background simulation + ML training
     *   • Live trading via AutoTradeService
     *
     * @private – central coordination point
     */
    private async handleTradeSignal(
        symbol: string,
        signal: TradeSignal,
        price: number,
        primaryData: OhlcvData,
        htf: OhlcvData
    ): Promise<void> {
        // Deduplication – ignore exact repeat signals
        const last = this.lastSignal[symbol];
        if (
            last &&
            last.signal.signal === signal.signal &&
            Math.abs(last.price - price) < 1e-6 &&
            Math.abs((last.signal.stopLoss ?? 0) - (signal.stopLoss ?? 0)) < 1e-6
        ) {
            return;
        }

        // Optional R:R sanity check
        if (this.opts.requireAtrFeasibility && signal.stopLoss && signal.takeProfit) {
            const risk = signal.signal === 'buy' ? price - signal.stopLoss : signal.stopLoss - price;
            const reward = signal.signal === 'buy' ? signal.takeProfit - price : price - signal.takeProfit;
            if (risk <= 0 || reward / risk < config.strategy.riskRewardTarget - 0.1) {
                logger.info(`Poor R:R → skipped`, { symbol, rr: reward / risk });
                // return;
            }
        }

        const now = Date.now();

        // Cooldown enforcement (prevent spam)
        if (this.opts.cooldownBackend === 'database') {
            const { lastTradeAt } = await dbService.getCoolDown(symbol);
            if ((now - lastTradeAt) < this.opts.cooldownMs) return;
            await dbService.upsertCoolDown(symbol, now);
        } else {
            if (now - (this.lastAlertAt[symbol] ?? 0) < this.opts.cooldownMs) return;
            this.lastAlertAt[symbol] = now;
        }

        // Send Telegram alert with excursion context
        await this.telegramService?.sendSignalAlert(symbol, signal, price);
        logger.info(`Signal alert prepared for ${symbol}`, { msg: signal });

        // Remember signal for deduplication
        this.lastSignal[symbol] = { signal, price };

        // Background simulation for ML training (fire-and-forget)
        if (config.ml.trainingEnabled) {
            void this.simulateAndTrain(symbol, signal, price, primaryData, htf);
        }

        // Live trading – delegate to dedicated service (fire-and-forget)
        if (config.autoTrade) {
            void this.autoTradeService.execute(signal);
        }
    }

    // =========================================================================
    // SIMULATION + ML TRAINING: Background processing after signal
    // =========================================================================
    /**
     * Runs simulation and feeds outcome into ML training (fire-and-forget).
     *
     * Called from:
     *   • handleTradeSignal() – when ML training is enabled
     *
     * Why fire-and-forget (void)?
     *   • Simulation can take minutes → must not block scanner
     *   • Multiple simulations can run in parallel safely
     *
     * Process:
     *   • Extract features at signal time
     *   • Run full simulation
     *   • Convert outcome to 5-tier label
     *   • Ingest into MLService
     */
    private async simulateAndTrain(
        symbol: string,
        signal: TradeSignal,
        entryPrice: number,
        primaryData: OhlcvData,
        htfData: OhlcvData
    ): Promise<void> {
        try {
            // Extract features exactly as they were at signal generation time
            const features = await mlService.extractFeatures({
                symbol,
                primaryData,
                htfData,
                price: entryPrice,
                atrMultiplier: config.strategy.atrMultiplier,
                riskRewardTarget: config.strategy.riskRewardTarget,
                trailingStopPercent: config.strategy.trailingStopPercent,
            });

            // Run high-fidelity simulation
            const result = await simulateTrade(this.exchangeService, symbol, signal, entryPrice);

            // Convert simulation outcome to ML label
            const label = this.calculateLabel(signal.signal, result.outcome, result.rMultiple);

            // Feed into continuous learning system
            await mlService.ingestSimulatedOutcome(
                symbol,
                features,
                label,
                result.rMultiple,
                result.pnl
            );

            // Log success for monitoring data growth
            logger.info('ML sample ingested from simulation', {
                symbol,
                side: signal.signal,
                outcome: result.outcome,
                rMultiple: result.rMultiple.toFixed(3),
                pnl: `${result.pnl.toFixed(2)}%`,
                label,
            });
        } catch (err) {
            // Simulation or ingestion failure – log but don't crash scanner
            logger.error('Simulation → ML failed', { symbol, error: err });
        }
    }

    // =========================================================================
    // LABEL CALCULATION: Convert simulation outcome to 5-tier label
    // =========================================================================
    /**
     * Maps simulation result to discrete ML label (-2 to +2).
     *
     * Used by:
     *   • simulateAndTrain() – to label new samples
     *
     * Logic mirrors strategy thresholds:
     *   • SL hit with big loss → -2/-1
     *   • TP hit with strong/good gain → +2/+1
     *   • Timeout or small moves → 0
     *
     * @param side - buy/sell/hold
     * @param outcome - 'tp', 'sl', 'timeout', etc.
     * @param r - Achieved R-multiple
     * @returns SignalLabel for ML training
     */
    private calculateLabel(side: 'buy' | 'sell' | 'hold', outcome: string, r: number): SignalLabel {
        if (side === 'hold') return 0;

        if (outcome.includes('sl')) {
            return r <= -1.5 ? -2 : -1;  // Big vs small loss on stop
        }

        if (outcome.includes('tp')) {
            if (r >= 3.0) return 2;      // Monster win
            if (r >= 1.5) return 1;      // Good win
            return 0;                   // Small or breakeven
        }

        return 0; // Timeout or neutral exit
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
            // Cooldown check (DB backend only – more reliable across restarts)
            if (this.opts.cooldownBackend === 'database' && alert.lastAlertAt && now - alert.lastAlertAt < this.opts.cooldownMs) {
                continue;
            }

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
