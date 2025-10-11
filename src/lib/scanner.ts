/**
 * MarketScanner orchestrates live market scanning for multiple symbols.
 * Fetches multi-timeframe OHLCV data, generates trade signals, and processes custom alerts.
 * Sends notifications via Telegram and maintains modularity with services.
 */

import { ExchangeService } from './services/exchange';
import { TelegramService } from './services/telegram';
import { dbService} from './db';
import { Strategy, type TradeSignal } from './strategy';
import { createLogger } from './logger';
import { config } from './config/settings';
import type { OhlcvData } from '../types';
import { AlertEvaluatorService } from './services/alertEvaluator';
import type { Alert } from './db/schema';

// Configuration Constants
const logger = createLogger('MarketScanner');

type ScannerMode = 'single' | 'periodic';
type CooldownBackend = 'database' | 'memory';

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

export class MarketScanner {
    private running = false;
    private isScanning = false;
    private scanTimer: NodeJS.Timeout | null = null;
    private scanCount = 0;
    private lastAlertAt: Record<string, number> = {};
    private htfCache: { [symbol: string]: { data: OhlcvData; lastCloseTime: number } } = {};
    private alertEvaluator: AlertEvaluatorService; // New instance

    constructor(
        private readonly exchangeService: ExchangeService,
        private readonly telegramService: TelegramService,
        private readonly strategy: Strategy,
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
        logger.info(`MarketScanner initialized in '${this.opts.mode}' mode.`);

        this.alertEvaluator = new AlertEvaluatorService();
    }

    async start(): Promise<void> {
        if (this.running) return;
        this.running = true;

        if (this.opts.mode === 'periodic') {
            await this.scanAllSymbols();
            this.scanTimer = setInterval(() => {
                if (!this.running) return;
                void this.scanAllSymbols();
            }, this.opts.intervalMs!);
            logger.info(`Periodic scanning started every ${this.opts.intervalMs! / 1000}s.`);
        } else {
            await this.scanAllSymbols();
            logger.info('Single scan completed.');
        }
    }

    stop(): void {
        this.running = false;
        if (this.scanTimer) {
            clearInterval(this.scanTimer);
            this.scanTimer = null;
            logger.info('MarketScanner stopped.');
        }
    }

    private async scanAllSymbols(): Promise<void> {
        if (this.isScanning) {
            logger.warn('Scan skipped: Previous scan is still in progress.');
            return;
        }

        this.isScanning = true;
        const scanStart = Date.now();
        const cycleCount = this.opts.cooldownBackend === 'database'
            ? await dbService.incrementHeartbeatCount()
            : ++this.scanCount;

        logger.info(`Scan cycle ${cycleCount} started`, { symbols: this.symbols });

        const queue = [...this.symbols];
        const workers = Array.from(
            { length: Math.min(this.opts.concurrency!, queue.length) },
            () => this.processWorker(queue)
        );
        await Promise.all(workers);

        await this.checkAlerts(this.symbols);

        if (cycleCount % this.opts.heartbeatCycles! === 0) {
            await this.telegramService.sendMessage(`Heartbeat: Scan completed over ${this.symbols.length} symbols`)
                .catch(err => logger.error('Failed to send Telegram heartbeat', { error: err }));
            if (this.opts.cooldownBackend === 'database') {
                await dbService.resetHeartbeatCount();
            }
            logger.info(`Heartbeat sent at cycle ${cycleCount}`);
        }

        this.isScanning = false;
        logger.info(`Scan cycle ${cycleCount} completed in ${Date.now() - scanStart}ms`);
    }

    private async processWorker(queue: string[]): Promise<void> {
        while (queue.length) {
            const symbol = queue.shift();
            if (!symbol) break;

            if (this.opts.jitterMs! > 0) {
                await new Promise(r => setTimeout(r, Math.floor(Math.random() * this.opts.jitterMs!)));
            }

            await this.withRetries(() => this.processSymbol(symbol), this.opts.retries!);
        }
    }

    private async processSymbol(symbol: string): Promise<void> {
        const primaryData = await this.exchangeService.getOHLCV(symbol, config.scanner.primaryTimeframe);

        if (primaryData.closes.length < 200) {
            logger.warn(`Insufficient ${config.scanner.primaryTimeframe} data for ${symbol}`);
            return;
        }

        let htfData: OhlcvData;
        const htfCacheEntry = this.htfCache[symbol];
        const htfCandleDurationMs = 60 * 60 * 1000;

        if (htfCacheEntry && (Date.now() - htfCacheEntry.lastCloseTime < htfCandleDurationMs)) {
            htfData = htfCacheEntry.data;
            logger.debug(`Using cached HTF data for ${symbol}:${config.scanner.htfTimeframe}`);
        } else {
            const htfOhlcv = await this.exchangeService.getOHLCV(symbol, config.scanner.htfTimeframe);
            htfData = htfOhlcv;
            if (htfData.closes.length < 200) {
                logger.warn(`Insufficient ${config.scanner.htfTimeframe} data for ${symbol}`);
                return;
            }
            this.htfCache[symbol] = {
                data: htfData,
                lastCloseTime: htfData.timestamps.at(-2)!,
            };
            logger.info(`Refreshed HTF data for ${symbol}:${config.scanner.htfTimeframe}`);
        }

        const latestPrice = primaryData.closes.at(-1)!;

        try {
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
            logger.error(`Strategy failed for ${symbol}`, { error });
            await this.telegramService.sendMessage(`Error processing ${symbol}: ${(error as Error).message}`)
                .catch(err => logger.error('Failed to send Telegram error', { error: err }));
        }
    }

    private async processTradeSignal(symbol: string, signal: TradeSignal, currentPrice: number): Promise<void> {
        if (this.opts.requireAtrFeasibility) {
            const { stopLoss, takeProfit } = signal;
            if (stopLoss && takeProfit) {
                const risk = signal.signal === 'buy' ? currentPrice - stopLoss : stopLoss - currentPrice;
                const reward = signal.signal === 'buy' ? takeProfit - currentPrice : currentPrice - takeProfit;
                if (risk <= 0 || reward / risk < config.strategy.riskRewardTarget) {
                    logger.debug(`Signal skipped for poor R:R on ${symbol}`);
                    return;
                }
            }
        }

        const now = Date.now();
        const cooldownMs = this.opts.cooldownMs!;

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

        const message = [
            `🚨 **${signal.signal.toUpperCase()} SIGNAL** 🚨`,
            `**Symbol:** ${symbol}`,
            `**Confidence:** ${signal.confidence.toFixed(0)}%`,
            `**Price:** $${currentPrice.toFixed(4)}`,
            signal.stopLoss ? `**Stop Loss:** $${signal.stopLoss.toFixed(4)}` : '',
            signal.takeProfit ? `**Take Profit:** $${signal.takeProfit.toFixed(4)} (~${config.strategy.riskRewardTarget}%)` : '',
            signal.trailingStopDistance ? `**Trailing Stop:** $${signal.trailingStopDistance.toFixed(4)}` : '',
            '**Reasons:**',
            ...signal.reason.map(r => `  • ${r}`),
        ].filter(Boolean).join('\n');

        await this.telegramService.sendMessage(message)
            .catch(err => logger.error(`Failed to send Telegram signal for ${symbol}`, { error: err }));
        logger.info(`Trade signal sent for ${symbol}`, { signal: signal.signal, confidence: signal.confidence });
    }

    private async checkAlerts(symbols: string[]): Promise<void> {
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
                if (alert.lastAlertAt && now - alert.lastAlertAt < (this.opts.cooldownMs!)) {
                    logger.debug(`Alert ${alert.id} for ${symbol} in cooldown`);
                    continue;
                }

                const data = await this.exchangeService.getOHLCV(symbol, timeframe);
                if (data.closes.length < config.historyLength) continue;

                const { conditionsMet, reasons } = this.alertEvaluator.evaluate(data, alert.conditions);

                if (conditionsMet) {
                    const message = [
                        `🔔 **Custom Alert Triggered** 🔔`,
                        `**Symbol:** ${symbol} (${timeframe})`,
                        `**Alert ID:** ${alert.id}`,
                        `**Conditions Met:**`,
                        ...reasons.map(r => `  • ${r}`),
                    ].join('\n');

                    await this.telegramService.sendMessage(message)
                        .catch(err => logger.error(`Failed to send Telegram alert ${alert.id}`, { error: err }));
                    await dbService.setLastAlertTime(alert.id, now);
                    logger.info(`Alert ${alert.id} triggered for ${symbol}`);
                }
            }
        }
    }


    private async withRetries<T>(fn: () => Promise<T>, retries: number): Promise<T> {
        let err: unknown;
        for (let i = 0; i <= retries; i++) {
            try {
                return await fn();
            } catch (e) {
                err = e;
                const delay = 300 * (i + 1);
                logger.warn(`Attempt ${i + 1} failed. Retrying in ${delay}ms`, { error: (e as Error).message });
                await new Promise(r => setTimeout(r, delay));
            }
        }
        throw err;
    }
}
