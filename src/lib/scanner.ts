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

    /**
     * Processes ONE trading symbol from start to finish during a scan cycle.
     *
     * High-level responsibilities in order:
     *   1. Fetch required OHLCV data (primary + higher timeframe)
     *   2. Generate the full TradeSignal using Strategy (technical + ML + excursion filtering)
     *   3. Trigger background simulation for every meaningful potential / final direction
     *      → we simulate even when final signal is 'hold' (skipped by excursion / no regime)
     *      → we prefer the final direction when the signal was approved
     *   4. Only alert / execute live trade when final signal is buy/sell
     *
     * Key decisions:
     *   - Simulation runs for every case where there is a clear direction (potential or final)
     *   - No extra cooldown or deduplication on simulation — we want dense history
     *     even during periods where alerts are throttled (e.g. 7-minute cooldown)
     *   - Alerting & live trading remain protected by the existing cooldown
     *     (handled inside handleTradeSignal)
     */
    private async processSymbol(symbol: string): Promise<void> {
        try {
            // ──────────────────────────────────────────────────────────────
            // 1. Get fast timeframe data (e.g. 3m) – main source for indicators
            // ──────────────────────────────────────────────────────────────
            const primaryData = await this.getPrimaryData(symbol);
            if (!primaryData || primaryData.closes.length < config.historyLength) {
                return; // not enough history – normal during warmup or illiquid symbols
            }

            // ──────────────────────────────────────────────────────────────
            // 2. Get higher timeframe data (e.g. 1h) – used for trend filter
            // ──────────────────────────────────────────────────────────────
            const htfData = await this.getHtfData(symbol);
            if (!htfData || htfData.closes.length < config.historyLength) {
                return;
            }

            const currentPrice = primaryData.closes.at(-1)!;

            // ──────────────────────────────────────────────────────────────
            // 3. Generate complete signal (technical + ML + excursion logic)
            // ──────────────────────────────────────────────────────────────
            const signal = await this.strategy.generateSignal({
                symbol,
                primaryData,
                htfData,
                price: currentPrice,
                atrMultiplier: config.strategy.atrMultiplier,
                riskRewardTarget: config.strategy.riskRewardTarget,
                trailingStopPercent: config.strategy.trailingStopPercent,
            });

            // ──────────────────────────────────────────────────────────────
            // 4. Decide which direction to simulate
            //
            // Priority:
            //   A. If final signal is buy/sell → simulate the FINAL direction
            //      (most correct when excursion approved or reversal succeeded)
            //   B. Otherwise fall back to potentialSignal
            //      (captures skipped signals, no-regime cases, failed reversals)
            //
            // We only skip simulation when both are 'hold' (no meaningful edge)
            // ──────────────────────────────────────────────────────────────
            let directionToSimulate: 'buy' | 'sell' | 'hold' = signal.potentialSignal;

            if (signal.signal !== 'hold') {
                directionToSimulate = signal.signal;
            }

            // ──────────────────────────────────────────────────────────────
            // 5. Trigger simulation for every meaningful direction
            //    → no extra cooldown/deduplication here
            //    → we want frequent simulation data even when alerts are throttled
            // ──────────────────────────────────────────────────────────────
            if (config.ml.trainingEnabled && directionToSimulate !== 'hold') {
                // Create simulation signal object using the chosen direction
                const simSignal = { ...signal, signal: directionToSimulate };

                logger.debug(`Triggering simulation: ${symbol} → ${directionToSimulate} @ ${currentPrice.toFixed(6)} ` +
                    `(final=${signal.signal}, potential=${signal.potentialSignal})`);

                // Fire-and-forget – simulation runs async and feeds ML
                void this.simulateAndTrain(symbol, simSignal, currentPrice, primaryData, htfData);
            }

            // ──────────────────────────────────────────────────────────────
            // 6. Alerting & live execution ONLY when final signal passed all filters
            //    (cooldown, R:R check, etc. happen inside handleTradeSignal)
            // ──────────────────────────────────────────────────────────────
            if (signal.signal !== 'hold') {
                await this.handleTradeSignal(symbol, signal, currentPrice);
            }

        } catch (err) {
            logger.error(`Error processing symbol ${symbol}`, {
                error: err instanceof Error ? err.stack : String(err)
            });
            // Continue with other symbols – one failure shouldn't stop the scan
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

    /**
 * Handles the alerting and live execution pipeline **only for signals that passed excursion filtering**
 * (i.e. final signal === 'buy' or 'sell').
 *
 * This method is called **exclusively** when `signal.signal !== 'hold'`.
 *
 * Responsibilities (in order):
 *   1. Deduplication check (avoid sending identical alerts / opening duplicate positions)
 *   2. Risk:Reward feasibility check (optional strict gate)
 *   3. Cooldown enforcement (prevents alert/trade spam – currently ~7 minutes)
 *   4. Send Telegram alert (with full signal details)
 *   5. Execute live trade (if autoTrade is enabled)
 *
 * IMPORTANT:
 *   → Simulation is NO LONGER done here
 *   → All simulation logic (including skipped / potential-only cases) is now centralized in processSymbol
 *   → This method is only concerned with real-time user-visible & execution actions
 *
 * @param symbol     Trading pair
 * @param signal     Final approved TradeSignal (signal === 'buy'|'sell')
 * @param price      Current market price
 * @param primaryData Primary timeframe OHLCV (passed for potential future use)
 * @param htf        Higher timeframe OHLCV (passed for potential future use)
 */
    private async handleTradeSignal(
        symbol: string,
        signal: TradeSignal,
        price: number,
    ): Promise<void> {
        // Safety: this method should never be called with hold
        if (signal.signal === 'hold') {
            logger.warn(`handleTradeSignal called with hold signal for ${symbol} – this should not happen`);
            return;
        }

        const now = Date.now();

        // ──────────────────────────────────────────────────────────────
        // 1. Deduplication: avoid sending the exact same alert / trade setup repeatedly
        //    (same direction, very similar price, same stop-loss)
        // ──────────────────────────────────────────────────────────────
        const last = this.lastSignal[symbol];
        if (
            last &&
            last.signal.signal === signal.signal &&
            Math.abs(last.price - price) < 1e-6 &&
            Math.abs((last.signal.stopLoss ?? 0) - (signal.stopLoss ?? 0)) < 1e-6
        ) {
            logger.debug(`Identical signal deduplicated for ${symbol} @ ${price.toFixed(6)}`);
            return;
        }

        // ──────────────────────────────────────────────────────────────
        // 2. Optional strict R:R feasibility check
        //    If disabled in config → we still proceed (soft gate)
        // ──────────────────────────────────────────────────────────────
        let rrValid = true;

        if (this.opts.requireAtrFeasibility && signal.stopLoss && signal.takeProfit) {
            const risk = signal.signal === 'buy'
                ? price - signal.stopLoss
                : signal.stopLoss - price;

            const reward = signal.signal === 'buy'
                ? signal.takeProfit - price
                : price - signal.takeProfit;

            rrValid = risk > 0 && (reward / risk) >= (config.strategy.riskRewardTarget - 0.1);

            if (!rrValid) {
                logger.info(`Poor R:R ratio – skipping alert & trade`, {
                    symbol,
                    direction: signal.signal,
                    rrAchieved: reward / risk,
                    rrRequired: config.strategy.riskRewardTarget,
                    stop: signal.stopLoss,
                    target: signal.takeProfit
                });
                return;
            }
        }

        // ──────────────────────────────────────────────────────────────
        // 3. Cooldown check – protects against alert/trade spam
        //    Uses either database or in-memory backend (configurable)
        // ──────────────────────────────────────────────────────────────
        let shouldProceed = true;

        if (this.opts.cooldownBackend === 'database') {
            const { lastTradeAt } = await dbService.getCoolDown(symbol);
            if (lastTradeAt && (now - lastTradeAt) < this.opts.cooldownMs) {
                shouldProceed = false;
                logger.debug(`Cooldown active (DB) for ${symbol} – no alert/trade`);
            } else {
                await dbService.upsertCoolDown(symbol, now);
            }
        } else {
            // Memory backend
            const lastAlertTime = this.lastAlertAt[symbol] ?? 0;
            if ((now - lastAlertTime) < this.opts.cooldownMs) {
                shouldProceed = false;
                logger.debug(`Cooldown active (memory) for ${symbol} – no alert/trade`);
            } else {
                this.lastAlertAt[symbol] = now;
            }
        }

        if (!shouldProceed) {
            return;
        }

        // ──────────────────────────────────────────────────────────────
        // 4. Send Telegram alert – visible action for the user
        // ──────────────────────────────────────────────────────────────
        if (this.telegramService) {
            try {
                await this.telegramService.sendSignalAlert(symbol, signal, price);
                logger.info(`Telegram alert sent successfully for ${symbol} (${signal.signal})`);
            } catch (alertErr) {
                logger.error(`Failed to send Telegram alert for ${symbol}`, { error: alertErr });
                // Do NOT return – we still want to try live trading if enabled
            }
        }

        // ──────────────────────────────────────────────────────────────
        // 5. Remember this signal for future deduplication
        // ──────────────────────────────────────────────────────────────
        this.lastSignal[symbol] = { signal, price };

        // ──────────────────────────────────────────────────────────────
        // 6. Execute live trade (if enabled in config)
        //    Fire-and-forget – execution is handled by AutoTradeService
        // ──────────────────────────────────────────────────────────────
        if (config.autoTrade) {
            logger.info(`Initiating live trade execution for ${symbol} (${signal.signal})`);
            void this.autoTradeService.execute(signal);
            // No await – we don't want to block the scanner loop
        }

        // Success path – everything that should happen, happened
        logger.debug(`handleTradeSignal completed for ${symbol} (${signal.signal})`);
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
