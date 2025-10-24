import { ExchangeService } from './services/exchange';
import { TelegramService } from './services/telegram';
import { dbService } from './db';
import { Strategy, type TradeSignal } from './strategy';
import { createLogger } from './logger';
import { config } from './config/settings';
import type { OhlcvData } from '../types';
import { AlertEvaluatorService } from './services/alertEvaluator';
import type { Alert } from './db/schema';
import { MLService } from './services/mlService';

const logger = createLogger('MarketScanner');

/**
 * Scanner mode: 'single' for one-time scan, 'periodic' for continuous scanning.
 */
type ScannerMode = 'single' | 'periodic';

/**
 * Cooldown backend: 'database' for persistent storage, 'memory' for in-memory tracking.
 */
type CooldownBackend = 'database' | 'memory';

/**
 * Configuration options for the MarketScanner.
 */
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
 * Manages the market scanning process for trading signals and custom alerts.
 * - Periodically scans configured symbols using primary and higher timeframe data.
 * - Generates trade signals via Strategy and executes trades automatically in testnet/live modes.
 * - Evaluates custom alerts and triggers Telegram notifications.
 * - Integrates with MLService for continuous training on trade outcomes.
 */
export class MarketScanner {
    private running = false;
    private isScanning = false;
    private scanTimer: NodeJS.Timeout | null = null;
    private scanCount = 0;
    private lastAlertAt: Record<string, number> = {};
    private htfCache: { [symbol: string]: { data: OhlcvData; lastCloseTime: number } } = {};
    private alertEvaluator: AlertEvaluatorService;

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
        private readonly exchangeService: ExchangeService,
        private readonly telegramService: TelegramService,
        private readonly strategy: Strategy,
        private readonly mlService: MLService,
        private readonly symbols: string[],
        private readonly opts: ScannerOptions = {
            mode: 'periodic',
            intervalMs: config.scanner.scanIntervalMs ?? 60_000,
            concurrency: 3,
            cooldownMs: 5 * 60_000,
            jitterMs: 250,
            retries: 1,
            heartbeatCycles: config.scanner.heartBeatInterval ?? 60,
            requireAtrFeasibility: true,
            cooldownBackend: 'database',
        }
    ) {
        this.alertEvaluator = new AlertEvaluatorService();
        logger.info(`MarketScanner initialized in '${this.opts.mode}' mode for ${symbols.length} symbols`, {
            symbols,
            intervalMs: this.opts.intervalMs,
            concurrency: this.opts.concurrency,
        });
    }

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

        if (this.opts.mode === 'periodic') {
            await this.scanAllSymbols();
            this.scanTimer = setInterval(() => {
                if (!this.running) return;
                void this.scanAllSymbols();
            }, this.opts.intervalMs!);
            logger.info(`Periodic scanning started every ${this.opts.intervalMs! / 1000}s`);
        } else {
            await this.scanAllSymbols();
            logger.info('Single scan completed');
            this.running = false;
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

    /**
     * Scans all configured symbols concurrently and checks custom alerts.
     * - Uses worker queue to manage concurrency.
     * - Updates heartbeat count and sends Telegram heartbeat periodically.
     * @private
     */
    private async scanAllSymbols(): Promise<void> {
        if (this.isScanning) {
            logger.warn('Scan skipped: Previous scan is still in progress');
            return;
        }

        this.isScanning = true;
        const scanStart = Date.now();
        const cycleCount = this.opts.cooldownBackend === 'database'
            ? await dbService.incrementHeartbeatCount()
            : ++this.scanCount;

        logger.info(`Scan cycle ${cycleCount} started`, { symbols: this.symbols });

        try {
            const queue = [...this.symbols];
            const workers = Array.from(
                { length: Math.min(this.opts.concurrency!, queue.length) },
                () => this.processWorker(queue)
            );
            await Promise.all(workers);

            await this.checkAlerts(this.symbols);

            if (cycleCount % this.opts.heartbeatCycles! === 0) {
                const message = `Heartbeat: Scan completed over ${this.symbols.length} symbols in ${Date.now() - scanStart}ms`;
                await this.telegramService.sendMessage(message).catch(err =>
                    logger.error('Failed to send Telegram heartbeat', { error: err })
                );
                if (this.opts.cooldownBackend === 'database') {
                    await dbService.resetHeartbeatCount();
                }
                logger.info(`Heartbeat sent at cycle ${cycleCount}`);
            }
        } catch (error) {
            logger.error('Scan cycle failed', { error });
            await this.telegramService.sendMessage(`❌ Scan cycle ${cycleCount} failed: ${(error as Error).message}`).catch(
                err => logger.error('Failed to send Telegram error', { error: err })
            );
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

            if (this.opts.jitterMs! > 0) {
                await new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * this.opts.jitterMs!)));
            }

            await this.withRetries(() => this.processSymbol(symbol), this.opts.retries!);
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
            const primaryData = await this.exchangeService.getOHLCV(symbol, config.scanner.primaryTimeframe);
            if (primaryData.closes.length < config.historyLength) {
                logger.warn(`Insufficient ${config.scanner.primaryTimeframe} data for ${symbol}`, {
                    length: primaryData.closes.length,
                });
                return;
            }

            let htfData: OhlcvData;
            const htfCacheEntry = this.htfCache[symbol];
            const htfCandleDurationMs = 60 * 60 * 1000; // 1 hour

            if (htfCacheEntry && Date.now() - htfCacheEntry.lastCloseTime < htfCandleDurationMs) {
                htfData = htfCacheEntry.data;
                logger.debug(`Using cached HTF data for ${symbol}:${config.scanner.htfTimeframe}`);
            } else {
                const htfOhlcv = await this.exchangeService.getOHLCV(symbol, config.scanner.htfTimeframe);
                htfData = htfOhlcv;
                if (htfData.closes.length < config.historyLength) {
                    logger.warn(`Insufficient ${config.scanner.htfTimeframe} data for ${symbol}`, {
                        length: htfData.closes.length,
                    });
                    return;
                }
                this.htfCache[symbol] = {
                    data: htfData,
                    lastCloseTime: htfData.timestamps.at(-1)!,
                };
                logger.info(`Refreshed HTF data for ${symbol}:${config.scanner.htfTimeframe}`);
            }

            const latestPrice = primaryData.closes.at(-1)!;
            const signal = this.strategy.generateSignal({
                symbol,
                primaryData,
                htfData,
                price: latestPrice,
                atrMultiplier: config.strategy.atrMultiplier,
                riskRewardTarget: config.strategy.riskRewardTarget,
                trailingStopPercent: config.strategy.trailingStopPercent,
            });

            if (signal.signal !== 'hold') {
                await this.processTradeSignal(symbol, signal, latestPrice);
            }
        } catch (error) {
            logger.error(`Failed to process ${symbol}`, { error });
            await this.telegramService.sendMessage(`❌ Error processing ${symbol}: ${(error as Error).message}`).catch(
                err => logger.error('Failed to send Telegram error', { error: err })
            );
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
        // Ensure we never attempt to place an order with a 'hold' signal.
        if (signal.signal === 'hold') {
            logger.debug(`Received 'hold' signal in processTradeSignal for ${symbol}, skipping`);
            return;
        }

        // Validate risk-reward ratio
        if (this.opts.requireAtrFeasibility && signal.stopLoss && signal.takeProfit) {
            const risk = signal.signal === 'buy' ? currentPrice - signal.stopLoss : signal.stopLoss - currentPrice;
            const reward = signal.signal === 'buy' ? signal.takeProfit - currentPrice : currentPrice - signal.takeProfit;
            if (risk <= 0 || reward / risk < config.strategy.riskRewardTarget) {
                logger.debug(`Signal skipped for ${symbol} due to poor R:R`, { reward, risk });
                return;
            }
        }

        // Check cooldown
        const now = Date.now();
        const cooldownMs = this.opts.cooldownMs!;
        if (this.opts.cooldownBackend === 'database') {
            const alerts = await dbService.getAlertsBySymbol(symbol);
            if (alerts.some(a => a.lastAlertAt && now - a.lastAlertAt < cooldownMs)) {
                logger.debug(`Signal skipped for ${symbol} due to cooldown`);
                return;
            }
            for (const alert of alerts) {
                await dbService.setLastAlertTime(alert.id, now);
            }
        } else {
            const last = this.lastAlertAt[symbol] ?? 0;
            if (now - last < cooldownMs) {
                logger.debug(`Signal skipped for ${symbol} due to in-memory cooldown`);
                return;
            }
            this.lastAlertAt[symbol] = now;
        }

        // Send Telegram notification
        const message = [
            `🚨 **${signal.signal.toUpperCase()} SIGNAL** 🚨`,
            `**Symbol:** ${symbol}`,
            `**Confidence:** ${signal.confidence.toFixed(0)}%`,
            `**Price:** $${currentPrice.toFixed(4)}`,
            signal.stopLoss ? `**Stop Loss:** $${signal.stopLoss.toFixed(4)}` : '',
            signal.takeProfit ? `**Take Profit:** $${signal.takeProfit.toFixed(4)} (~${config.strategy.riskRewardTarget} R:R)` : '',
            signal.trailingStopDistance ? `**Trailing Stop:** $${signal.trailingStopDistance.toFixed(4)}` : '',
            `**Mode:** ${this.exchangeService.isLive ? 'Live' : 'Testnet'}`,
            '**Reasons:**',
            ...signal.reason.map(r => `* ${r}`),
        ].filter(Boolean).join('\n');

        await this.telegramService.sendMessage(message, { parse_mode: 'HTML' }).catch(err =>
            logger.error(`Failed to send Telegram signal for ${symbol}`, { error: err })
        );
        logger.info(`Trade signal sent for ${symbol}`, { signal: signal.signal, confidence: signal.confidence });

        // Execute trade if auto-trading is enabled
        if (config.autoTrade) {
            try {
                const balance = await this.exchangeService.getAccountBalance();
                const positionSize = (balance ?? 0) * (config.strategy.positionSizePercent / 100);
                const amount = positionSize / currentPrice;

                const order = await this.exchangeService.placeOrder(
                    symbol,
                    signal.signal,
                    amount,
                    signal.stopLoss,
                    signal.takeProfit,
                    signal.trailingStopDistance
                );

                // Log trade to database
                await dbService.logTrade({
                    symbol,
                    side: signal.signal,
                    amount,
                    price: currentPrice,
                    timestamp: now,
                    mode: this.exchangeService.isLive ? 'live' : 'testnet',
                    orderId: order.id,
                });

                logger.info(`Trade executed for ${symbol}`, {
                    side: signal.signal,
                    amount,
                    price: currentPrice,
                    mode: this.exchangeService.isLive ? 'live' : 'testnet',
                });

                // Monitor trade outcome for ML training
                await this.monitorTradeOutcome(symbol, signal, amount, now);
            } catch (error) {
                logger.error(`Failed to execute trade for ${symbol}`, { error });
                await this.telegramService.sendMessage(`❌ Trade execution failed for ${symbol}: ${(error as Error).message}`).catch(
                    err => logger.error('Failed to send Telegram error', { error: err })
                );
            }
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
    private async monitorTradeOutcome(symbol: string, signal: TradeSignal, amount: number, startTime: number): Promise<void> {
        if (!config.trainingMode && !this.exchangeService.isLive) {
            logger.debug(`Training skipped for ${symbol}: trainingMode=${config.trainingMode}, isLive=${this.exchangeService.isLive}`);
            return;
        }

        try {
            const timeoutMs = 3600 * 1000; // 1 hour
            let position = null;

            while (Date.now() - startTime < timeoutMs) {
                const positions = await this.exchangeService.getPositions(symbol);
                position = positions.find(p => p.side === signal.signal);
                if (!position) break; // Position closed
                await new Promise(resolve => setTimeout(resolve, 60_000)); // Poll every minute
            }

            const trades = await this.exchangeService.getClosedTrades(symbol, startTime);
            const lastTrade = trades.find(
                t => t.side === signal.signal && typeof t.amount === 'number' && Math.abs(t.amount - amount) < 0.0001
            );

            let profit = 0;
            if (lastTrade) {
                profit = lastTrade.info?.realized_pnl ?? 0;
            } else if (position) {
                const unrealized = position.unrealizedPnl ?? 0;
                profit = signal.signal === 'buy' ? unrealized : -unrealized;
                // Close open position if still open
                await this.exchangeService.placeOrder(symbol, signal.signal === 'buy' ? 'sell' : 'buy', amount);
                logger.info(`Closed open position for ${symbol} due to timeout`);
            }

            const label = signal.signal === 'buy' ? (profit > 0 ? 1 : -1) : (profit > 0 ? -1 : 1);
            await this.mlService.addTrainingSample(symbol, signal.features, label);
            logger.info(`Training sample added for ${symbol}`, {
                label,
                profit,
                mode: this.exchangeService.isLive ? 'live' : 'testnet',
            });
        } catch (error) {
            logger.error(`Failed to monitor trade outcome for ${symbol}`, { error });
        }
    }

    /**
     * Checks custom alerts for all symbols and triggers notifications if conditions are met.
     * @param symbols - Array of symbols to check alerts for.
     * @private
     */
    private async checkAlerts(symbols: string[]): Promise<void> {
        try {
            const alerts = await dbService.getActiveAlerts();
            const groupedAlerts = alerts.reduce((acc, alert) => {
                if (!symbols.includes(alert.symbol)) return acc;
                const tf = alert.timeframe || config.scanner.primaryTimeframe;
                if (!acc[tf]) acc[tf] = [];
                acc[tf].push(alert);
                return acc;
            }, {} as Record<string, Alert[]>);

            for (const [timeframe, tfAlerts] of Object.entries(groupedAlerts)) {
                for (const alert of tfAlerts) {
                    const { symbol } = alert;
                    const now = Date.now();
                    if (alert.lastAlertAt && now - alert.lastAlertAt < this.opts.cooldownMs!) {
                        logger.debug(`Alert ${alert.id} for ${symbol} in cooldown`);
                        continue;
                    }

                    const data = await this.exchangeService.getOHLCV(symbol, timeframe);
                    if (data.closes.length < config.historyLength) {
                        logger.warn(`Insufficient ${timeframe} data for alert ${alert.id} on ${symbol}`, {
                            length: data.closes.length,
                        });
                        continue;
                    }

                    const { conditionsMet, reasons } = this.alertEvaluator.evaluate(data, alert.conditions);

                    if (conditionsMet) {
                        const message = [
                            `🔔 **Custom Alert Triggered** 🔔`,
                            `**Symbol:** ${symbol} (${timeframe})`,
                            `**Alert ID:** ${alert.id}`,
                            `**Conditions Met:**`,
                            ...reasons.map(r => `  • ${r}`),
                        ].join('\n');

                        await this.telegramService.sendMessage(message).catch(err =>
                            logger.error(`Failed to send Telegram alert ${alert.id}`, { error: err })
                        );
                        await dbService.setLastAlertTime(alert.id, now);
                        logger.info(`Alert ${alert.id} triggered for ${symbol}`);
                    }
                }
            }
        } catch (error) {
            logger.error('Failed to check alerts', { error });
            await this.telegramService.sendMessage(`❌ Failed to check alerts: ${(error as Error).message}`).catch(err =>
                logger.error('Failed to send Telegram error', { error: err })
            );
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
        let lastError: unknown;
        for (let i = 0; i <= retries; i++) {
            try {
                return await fn();
            } catch (error) {
                lastError = error;
                const delay = 300 * (i + 1);
                logger.warn(`Attempt ${i + 1} failed. Retrying in ${delay}ms`, { error: (error as Error).message });
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
        throw lastError;
    }
}
