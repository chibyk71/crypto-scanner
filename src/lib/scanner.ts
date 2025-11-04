// src/lib/scanner.ts
import { ExchangeService } from './services/exchange';                                 // ← Wrapper around CCXT or exchange API (fetch OHLCV, place orders, etc.)
import { dbService } from './db';                                                      // ← Singleton DB wrapper (Prisma, SQLite, etc.) – logs trades, alerts, heartbeats
import { Strategy, type TradeSignal } from './strategy';                               // ← The core signal engine we just analyzed
import { createLogger } from './logger';                                               // ← Winston/Pino logger factory
import { config } from './config/settings';                                            // ← Central config (intervals, risk params, auto-trade flag, etc.)
import type { OhlcvData } from '../types';                                             // ← { timestamps[], opens[], highs[], lows[], closes[], volumes[], symbol }
import { AlertEvaluatorService } from './services/alertEvaluator';                     // ← Evaluates user-defined alert conditions on OHLCV data
import type { Alert } from './db/schema';                                              // ← DB schema for custom alerts
import { MLService } from './services/mlService';                                      // ← Trains/predicts on trade outcomes
import type { TelegramBotController } from './services/telegramBotController';        // ← Sends formatted messages to Telegram
import { simulateTrade } from './services/simulateTrade';                              // ← Paper-trades a signal to get outcome & PnL without real money

const logger = createLogger('MarketScanner');                                           // ← Dedicated logger for this module

/**
 * Scanner mode: 'single' for one-time scan, 'periodic' for continuous scanning.
 */
type ScannerMode = 'single' | 'periodic';                                               // ← Controls whether scanner runs once or loops

/**
 * Cooldown backend: 'database' for persistent storage, 'memory' for in-memory tracking.
 */
type CooldownBackend = 'database' | 'memory';                                           // ← Where to store per-symbol cooldown timestamps

interface CachedHtf {                                                                   // ← Cache entry for higher-timeframe (1h) data
    data: OhlcvData;                                                                    // ← Full OHLCV array
    lastCloseTime: number;                                                              // ← Timestamp of the last closed candle (to detect new HTF candle)
    lastFetchTime: number;                                                              // ← When we last pulled from API (for stale-check)
}

/**
 * Configuration options for the MarketScanner.
 */
type ScannerOptions = {                                                                 // ← All tunable runtime options
    mode?: ScannerMode;                                                                 // ← 'single' or 'periodic'
    intervalMs?: number;                                                                // ← How often to scan in periodic mode
    concurrency?: number;                                                               // ← How many symbols to process in parallel
    cooldownMs?: number;                                                                // ← Minimum time between signals per symbol
    jitterMs?: number;                                                                  // ← Random delay between symbol requests (rate-limit safety)
    retries?: number;                                                                   // ← How many times to retry failed API calls
    heartbeatCycles?: number;                                                           // ← Send Telegram heartbeat every N scan cycles
    requireAtrFeasibility?: boolean;                                                    // ← Validate R:R before sending signal
    cooldownBackend?: CooldownBackend;                                                  // ← 'database' = persistent, 'memory' = in-process
};

/**
 * Manages the market scanning process for trading signals and custom alerts.
 * - Periodically scans configured symbols using primary and higher timeframe data.
 * - Generates trade signals via Strategy and executes trades automatically in testnet/live modes.
 * - Evaluates custom alerts and triggers Telegram notifications.
 * - Integrates with MLService for continuous training on trade outcomes.
 */
export class MarketScanner {
    private running = false;                                                            // ← Is the scanner globally active?
    private isScanning = false;                                                         // ← Is a scan cycle currently in progress? (prevents overlap)
    private scanTimer: NodeJS.Timeout | null = null;                                    // ← setInterval reference for periodic mode
    private scanCount = 0;                                                              // ← In-memory cycle counter (used when cooldownBackend = 'memory')
    private lastAlertAt: Record<string, number> = {};                                   // ← In-memory cooldown: symbol → last alert timestamp
    private lastSignal: Record<string, { signal: TradeSignal; price: number }> = {};     // ← Deduplication: last real signal per symbol
    private htfCache: Record<string, CachedHtf> = {};                                   // ← HTF (1h) data cache to avoid refetching every 3m
    private alertEvaluator = new AlertEvaluatorService();                               // ← Evaluates user-defined conditions (e.g. RSI < 30)

    /**
         * Initializes the MarketScanner with dependencies and configuration.
         * @param exchangeService - Service for fetching market data and executing trades.
         * @param telegramService - Service for sending Telegram notifications.
         * @param strategy - Strategy instance for generating trade signals.
         * @param mlService - MLService for training and predictions.
         * @param symbols - Array of symbols to scan (e.g., ['BTC/USDT', 'ETH/USDT']).
         * @param opts - Scanner configuration options.
         */
    constructor(
        private readonly exchangeService: ExchangeService,                              // ← Injected – handles all exchange I/O
        private readonly telegramService: TelegramBotController | null,                 // ← Optional – null in CLI-only mode
        private readonly strategy: Strategy,                                            // ← Injected – generates TradeSignal
        private readonly mlService: MLService,                                          // ← Injected – trains on outcomes
        private readonly symbols: string[],                                             // ← List of markets to monitor
        opts: ScannerOptions = {}                                                       // ← Optional overrides
    ) {
        // Merge defaults from config with user-provided opts
        this.opts = {
            mode: 'periodic',
            intervalMs: config.scanner.scanIntervalMs ?? 60_000,
            concurrency: 3,
            cooldownMs: 5 * 60_000,
            jitterMs: 250,
            retries: 1,
            heartbeatCycles: config.scanner.heartBeatInterval ?? 60,
            requireAtrFeasibility: true,
            cooldownBackend: 'database',
            ...opts,
        };

        logger.info(`MarketScanner initialized in '${this.opts.mode}' mode for ${symbols.length} symbols`, {
            symbols,
            intervalMs: this.opts.intervalMs,
            concurrency: this.opts.concurrency,
        });
    }

    private readonly opts: Required<ScannerOptions>;                                    // ← Fully-typed options after merging defaults

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

        // Clear any stale OHLCV cache from previous runs
        this.exchangeService.clearCache();
        logger.info('OHLCV cache cleared on scanner start');

        if (this.opts.mode === 'periodic') {
            // Run one immediate scan so we don't wait full interval
            await this.scanAllSymbols();
            // Schedule future scans
            this.scanTimer = setInterval(() => {
                if (!this.running) return;
                void this.scanAllSymbols();                                             // ← Fire-and-forget (async)
            }, this.opts.intervalMs);

            // Periodic cache cleanup (every 6 hours)
            setInterval(() => {
                this.exchangeService.clearCache();
                logger.info('OHLCV cache cleared (periodic maintenance)');
            }, 6 * 60 * 60 * 1000);

            logger.info(`Periodic scanning started every ${this.opts.intervalMs / 1000}s`);
        } else {
            await this.scanAllSymbols();
            logger.info('Single scan completed');
            this.running = false;                                                       // ← Auto-stop after one run
        }
    }

    /**
     * Stops the scanner and clears the periodic timer.
     */
    public stop(): void {
        this.running = false;
        if (this.scanTimer) {
            clearInterval(this.scanTimer);
            this.scanTimer = null;
            logger.info('MarketScanner stopped');
        }
    }

    private async scanAllSymbols(): Promise<void> {
        if (this.isScanning) {
            logger.warn('Scan skipped: previous scan still in progress');
            return;
        }
        this.isScanning = true;
        const scanStart = Date.now();
        const cycleCount =
            this.opts.cooldownBackend === 'database'
                ? await dbService.incrementHeartbeatCount()                             // ← Persistent counter in DB
                : ++this.scanCount;                                                     // ← In-memory counter

        logger.info(`Scan cycle ${cycleCount} started`, { symbols: this.symbols });

        try {
            // === CONCURRENT SYMBOL PROCESSING ===
            const queue = [...this.symbols];                                            // ← Clone to avoid mutation
            const workers = Array.from(
                { length: Math.min(this.opts.concurrency, queue.length) },
                () => this.processWorker(queue)                                         // ← Each worker pulls from shared queue
            );
            await Promise.all(workers);                                                 // ← All symbols processed in parallel

            // === ALERT EVALUATION (after all symbols have fresh data) ===
            await this.checkAlerts(this.symbols);

            // === HEARTBEAT (every N cycles) ===
            if (cycleCount % this.opts.heartbeatCycles === 0) {
                const msg = `Heartbeat: Scan completed over ${this.symbols.length} symbols in ${Date.now() - scanStart}ms`;
                await this.telegramService?.sendMessage(msg).catch(err =>
                    logger.error('Failed to send Telegram heartbeat', { error: err })
                );
                if (this.opts.cooldownBackend === 'database') {
                    await dbService.resetHeartbeatCount();                              // ← Reset for next heartbeat
                }
                logger.info(`Heartbeat sent at cycle ${cycleCount}`);
            }
        } catch (err) {
            logger.error('Scan cycle failed', { error: err });
            await this.telegramService
                ?.sendMessage(`Scan cycle ${cycleCount} failed: ${(err as Error).message}`)
                .catch(e => logger.error('Failed to send Telegram error', { error: e }));
        } finally {
            this.isScanning = false;
            logger.info(`Scan cycle ${cycleCount} completed in ${Date.now() - scanStart}ms`);
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
                await new Promise(r => setTimeout(r, Math.floor(Math.random() * this.opts.jitterMs)));
            }
            // Retry wrapper handles transient API failures
            await this.withRetries(() => this.processSymbol(symbol), this.opts.retries);
        }
    }

    /**
         * Processes a single symbol, generating and acting on trade signals.
         * - Fetches OHLCV data, generates signals, and executes trades if applicable.
         * @param symbol - Trading symbol (e.g., 'BTC/USDT').
         * @private
         */
    private async processSymbol(symbol: string): Promise<void> {
        try {
            // === PRIMARY TF: Use live polling (WebSocket or cached) ===
            const primaryRaw = this.exchangeService.getPrimaryOhlcvData(symbol);        // ← May return in-memory live buffer
            let primaryData: OhlcvData;

            if (primaryRaw && primaryRaw.length >= config.historyLength) {
                // Use last N candles from live buffer
                primaryData = this.exchangeService.toOhlcvData(primaryRaw.slice(-config.historyLength), symbol);
                logger.debug(`Using live primary data for ${symbol}`);
            } else {
                logger.warn(`Live primary data insufficient for ${symbol}, forcing API refresh`);
                primaryData = await this.exchangeService.getOHLCV(
                    symbol,
                    config.scanner.primaryTimeframe,                                    // ← e.g., '3m'
                    undefined,
                    undefined,
                    true                                                                // ← force refresh (bypass cache)
                );
                if (primaryData.length < config.historyLength) {
                    logger.warn(`Still insufficient primary data for ${symbol}`, { length: primaryData.closes.length });
                    return;
                }
            }

            // === HTF: Smart refresh (only when new candle closes or stale) ===
            const htfTimeframe = config.scanner.htfTimeframe;                           // ← e.g., '1h'
            const htfMs = ExchangeService.toTimeframeMs(htfTimeframe);
            const now = Date.now();
            const currentCandleStart = Math.floor(now / htfMs) * htfMs;                  // ← Start time of current HTF candle

            const cached = this.htfCache[symbol];
            const shouldRefresh =
                !cached ||
                cached.lastCloseTime < currentCandleStart ||                            // ← New HTF candle closed
                now - cached.lastFetchTime > 5 * 60 * 1000;                              // ← Cache older than 5 min

            let htfData: OhlcvData;
            if (shouldRefresh) {
                htfData = await this.exchangeService.getOHLCV(symbol, htfTimeframe, undefined, undefined, true);
                if (htfData.closes.length < config.historyLength) {
                    logger.warn(`Insufficient HTF data for ${symbol}`, { length: htfData.closes.length });
                    return;
                }
                this.htfCache[symbol] = {
                    data: htfData,
                    lastCloseTime: htfData.timestamps.at(-1)!,                          // ← Most recent closed candle
                    lastFetchTime: now,
                };
                logger.info(`Refreshed HTF data for ${symbol}:${htfTimeframe}`);
            } else {
                htfData = cached.data;
                logger.debug(`Using cached HTF data for ${symbol}:${htfTimeframe}`);
            }

            const latestPrice = primaryData.closes.at(-1)!;                             // ← Current close = entry price
            const signal = this.strategy.generateSignal({
                symbol,
                primaryData,
                htfData,
                price: latestPrice,
                atrMultiplier: config.strategy.atrMultiplier,
                riskRewardTarget: config.strategy.riskRewardTarget,
                trailingStopPercent: config.strategy.trailingStopPercent,
            });                                              // ← Debug print of full signal

            if (signal.signal !== 'hold') {
                await this.processTradeSignal(symbol, signal, latestPrice);
            }
        } catch (err) {
            logger.error(`Error processing ${symbol}`, { error: err });
            await this.telegramService
                ?.sendMessage(`Error processing ${symbol}: ${(err as Error).message}`)
                .catch(e => logger.error('Failed to send Telegram error', { error: e }));
        }
    }

    /**
         * Processes a trade signal, executing trades and collecting training data.
         * - Validates signal feasibility, applies cooldown, and executes trades in testnet/live mode.
         * - Logs trades to the database and collects ML training samples.
         * @param symbol - Trading symbol.
         * @param signal - Trade signal with confidence, stop loss, take profit, etc.
         * @param currentPrice - Current market price.
         * @private
         */
    private async processTradeSignal(symbol: string, signal: TradeSignal, currentPrice: number): Promise<void> {
        if (signal.signal === 'hold') return;

        // === DUPLICATE GUARD: Avoid spamming same signal ===
        const last = this.lastSignal[symbol];
        const isDuplicate =
            last &&
            last.signal.signal === signal.signal &&
            Math.abs(last.price - currentPrice) < 1e-4 &&
            Math.abs((last.signal.stopLoss ?? 0) - (signal.stopLoss ?? 0)) < 1e-4 &&
            Math.abs((last.signal.takeProfit ?? 0) - (signal.takeProfit ?? 0)) < 1e-4;

        if (isDuplicate) {
            logger.debug(`Skipping duplicate signal for ${symbol}`);
            return;
        }

        // === R:R VALIDATION (optional) ===
        if (this.opts.requireAtrFeasibility && signal.stopLoss && signal.takeProfit) {
            const risk = signal.signal === 'buy' ? currentPrice - signal.stopLoss : signal.stopLoss - currentPrice;
            const reward = signal.signal === 'buy' ? signal.takeProfit - currentPrice : currentPrice - signal.takeProfit;
            if (risk <= 0 || reward / risk < config.strategy.riskRewardTarget) {
                logger.debug(`Signal skipped for ${symbol} due to poor R:R`, { reward, risk });
                return;
            }
        }

        // === COOLDOWN (per-symbol) ===
        const now = Date.now();
        const cooldownMs = this.opts.cooldownMs;
        if (this.opts.cooldownBackend === 'database') {
            const alerts = await dbService.getAlertsBySymbol(symbol);
            if (alerts.some(a => a.lastAlertAt && now - a.lastAlertAt < cooldownMs)) {
                logger.debug(`Signal skipped for ${symbol} due to DB cooldown`);
                return;
            }
            for (const a of alerts) await dbService.setLastAlertTime(a.id, now);
        } else {
            const last = this.lastAlertAt[symbol] ?? 0;
            if (now - last < cooldownMs) {
                logger.debug(`Signal skipped for ${symbol} due to in-memory cooldown`);
                return;
            }
            this.lastAlertAt[symbol] = now;
        }

        // === TELEGRAM NOTIFICATION (MarkdownV2 escaped) ===
        const escape = (s: string) => s.replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
        const msg = [
            `**${signal.signal.toUpperCase()} SIGNAL**`,
            `**Symbol:** ${escape(symbol)}`,
            `**Confidence:** ${signal.confidence.toFixed(0)}%`,
            `**Price:** $${escape(currentPrice.toFixed(4))}`,
            signal.stopLoss ? `**Stop Loss:** $${escape(signal.stopLoss.toFixed(4))}` : '',
            signal.takeProfit
                ? `**Take Profit:** $${escape(signal.takeProfit.toFixed(4))} \\(\\~${config.strategy.riskRewardTarget} R:R\\)`
                : '',
            signal.trailingStopDistance
                ? `**Trailing Stop:** $${escape(signal.trailingStopDistance.toFixed(4))}`
                : '',
            `**Reasons:**`,
            ...signal.reason.map(r => `• ${escape(r)}`),
        ]
            .filter(Boolean)
            .join('\n');
        await this.telegramService
            ?.sendMessage(msg, { parse_mode: 'MarkdownV2' })
            .catch(err => logger.error(`Failed to send Telegram signal for ${symbol}`, { error: err }));

        // === REMEMBER LAST SIGNAL (for deduplication) ===
        this.lastSignal[symbol] = { signal, price: currentPrice };

        // === LIVE TRADING (if enabled) ===
        if (config.autoTrade) {
            void this.executeLiveTrade(symbol, signal, currentPrice, now);              // ← Fire-and-forget
        }

        // === ML TRAINING (simulate outcome in background) ===
        if (config.trainingMode) {
            void this.simulateAndTrain(symbol, signal, currentPrice);                   // ← Fire-and-forget
        }
    }

    private async executeLiveTrade(symbol: string, signal: TradeSignal, currentPrice: number, now: number): Promise<void> {
        try {
            const balance = await this.exchangeService.getAccountBalance();             // ← Total account equity
            const positionSize = (balance ?? 0) * (config.strategy.positionSizePercent / 100);
            const amount = positionSize / currentPrice;                                 // ← Base asset amount
            const side: 'buy' | 'sell' = signal.signal as 'buy' | 'sell';
            const order = await this.exchangeService.placeOrder(
                symbol,
                side,
                amount,
                signal.stopLoss,
                signal.takeProfit,
                signal.trailingStopDistance
            );
            await dbService.logTrade({
                symbol,
                side,
                amount,
                price: currentPrice,
                timestamp: now,
                mode: 'live',
                orderId: order.id,
            });
            logger.info(`Live trade executed`, { symbol, side });
            await this.monitorLiveTradeOutcome(symbol, signal, amount, now);            // ← Track until exit
        } catch (error) {
            logger.error(`Failed to execute trade for ${symbol}`, { error });
            await this.telegramService?.sendMessage(`Trade execution failed for ${symbol}: ${(error as Error).message}`).catch(
                err => logger.error('Failed to send Telegram error', { error: err })
            );
        }
    }

    private async simulateAndTrain(symbol: string, signal: TradeSignal, entryPrice: number): Promise<void> {
        try {
            const primaryRaw = this.exchangeService.getPrimaryOhlcvData(symbol);
            if (!primaryRaw || primaryRaw.length < config.historyLength) return;

            const primaryData = this.exchangeService.toOhlcvData(primaryRaw.slice(-config.historyLength));
            const htfData = this.htfCache[symbol]?.data;
            if (!htfData) return;

            const input = {
                symbol,
                primaryData,
                htfData,
                price: entryPrice,
                atrMultiplier: config.strategy.atrMultiplier,
                riskRewardTarget: config.strategy.riskRewardTarget,
                trailingStopPercent: config.strategy.trailingStopPercent,
            };

            const features = this.mlService.extractFeatures(input);
            const { outcome, pnl } = await simulateTrade(this.exchangeService, symbol, signal, entryPrice);
            const label = outcome === 'tp' ? 1 : 0;                                     // ← 1 = hit TP, 0 = hit SL

            await this.mlService.addTrainingSample(symbol, features, label);
            logger.info(`ML sample added`, { symbol, side: signal.signal, outcome, pnl: pnl.toFixed(4), label });
        } catch (err) {
            logger.error(`ML simulation failed for ${symbol}`, { error: err });
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
    private async monitorLiveTradeOutcome(symbol: string, signal: TradeSignal, amount: number, startTime: number): Promise<void> {
        if (!config.trainingMode) return;

        try {
            const timeoutMs = 3600 * 1000;                                              // ← 1 hour max
            let position: any = null;
            while (Date.now() - startTime < timeoutMs) {
                const positions = await this.exchangeService.getPositions(symbol);
                position = positions.find((p: any) => p.side === signal.signal);
                if (!position) break;                                                   // ← Trade closed
                await new Promise(r => setTimeout(r, 60_000));                          // ← Poll every minute
            }

            const trades = await this.exchangeService.getClosedTrades(symbol, startTime);
            const match = trades.find(
                (t: any) => t.side === signal.signal && Math.abs(t.amount - amount) < 0.0001
            );

            let profit = 0;
            if (match) {
                profit = match.info?.realized_pnl ?? 0;
            } else if (position) {
                const unreal = position.unrealizedPnl ?? 0;
                profit = signal.signal === 'buy' ? unreal : -unreal;
                await this.exchangeService.placeOrder(symbol, signal.signal === 'buy' ? 'sell' : 'buy', amount);
                logger.info(`Closed lingering position for ${symbol}`);
            }

            // Label: +1 if profitable in the correct direction
            const label = signal.signal === 'buy' ? (profit > 0 ? 1 : -1) : (profit > 0 ? -1 : 1);
            const primaryRaw = this.exchangeService.getPrimaryOhlcvData(symbol);
            if (primaryRaw) {
                const primaryData = this.exchangeService.toOhlcvData(primaryRaw.slice(-config.historyLength));
                const htfData = this.htfCache[symbol]?.data;
                if (htfData) {
                    const input = { symbol, primaryData, htfData, price: primaryData.closes.at(-1)!, atrMultiplier: config.strategy.atrMultiplier, riskRewardTarget: config.strategy.riskRewardTarget, trailingStopPercent: config.strategy.trailingStopPercent };
                    const features = this.mlService.extractFeatures(input);
                    await this.mlService.addTrainingSample(symbol, features, label);
                }
            }
        } catch (err) {
            logger.error(`Failed to monitor live trade for ${symbol}`, { error: err });
        }
    }

    private async checkAlerts(symbols: string[]): Promise<void> {
        try {
            const alerts = await dbService.getActiveAlerts();
            const grouped = alerts.reduce((acc, a) => {
                if (!symbols.includes(a.symbol)) return acc;
                const tf = a.timeframe || config.scanner.primaryTimeframe;
                if (!acc[tf]) acc[tf] = [];
                acc[tf].push(a);
                return acc;
            }, {} as Record<string, Alert[]>);

            for (const [tf, tfAlerts] of Object.entries(grouped)) {
                for (const alert of tfAlerts) {
                    const { symbol } = alert;
                    const now = Date.now();
                    if (alert.lastAlertAt && now - alert.lastAlertAt < this.opts.cooldownMs) {
                        logger.debug(`Alert ${alert.id} for ${symbol} in cooldown`);
                        continue;
                    }

                    const data = await this.exchangeService.getOHLCV(symbol, tf, undefined, undefined, true);
                    if (data.closes.length < config.historyLength) {
                        logger.warn(`Insufficient ${tf} data for alert ${alert.id} on ${symbol}`, { length: data.closes.length });
                        continue;
                    }

                    const { conditionsMet, reasons } = this.alertEvaluator.evaluate(data, alert.conditions);
                    if (conditionsMet) {
                        const msg = [
                            `**Custom Alert Triggered**`,
                            `**Symbol:** ${symbol} (${tf})`,
                            `**Alert ID:** ${alert.id}`,
                            `**Conditions Met:**`,
                            ...reasons.map(r => ` • ${r}`),
                        ].join('\n');
                        await this.telegramService?.sendMessage(msg).catch(err =>
                            logger.error(`Failed to send Telegram alert ${alert.id}`, { error: err })
                        );
                        await dbService.setLastAlertTime(alert.id, now);
                        logger.info(`Alert ${alert.id} triggered for ${symbol}`);
                    }
                }
            }
        } catch (err) {
            logger.error('Failed to check alerts', { error: err });
        }
    }

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
                const delay = 300 * (i + 1);                                            // ← Exponential backoff: 300ms, 600ms, 900ms...
                logger.warn(`Attempt ${i + 1} failed – retrying in ${delay}ms`, { error: (err as Error).message });
                await new Promise(r => setTimeout(r, delay));
            }
        }
        throw lastErr;
    }
}
