import { ExchangeService } from './services/exchange';
import { TelegramService } from './services/telegram';
import { dbService } from './db';
import { Strategy, type TradeSignal } from './strategy';
import { createLogger } from './logger';
import { config } from './config/settings';

const logger = createLogger('MarketScanner');

type ScannerMode = 'single' | 'periodic';
type CooldownBackend = 'database' | 'memory';

type ScannerOptions = {
    mode?: ScannerMode; // 'single' for one-off scans, 'periodic' for scheduled scans
    intervalMs?: number; // Scan interval for periodic mode (ms)
    concurrency: number; // Max number of symbols processed concurrently
    cooldownMs?: number; // Cooldown period between alerts (ms)
    jitterMs?: number; // Random delay to avoid rate limits (ms)
    retries?: number; // Number of retries for transient errors
    heartbeatCycles?: number; // Send heartbeat every N cycles
    requireAtrFeasibility?: boolean; // Check ATR-based feasibility
    cooldownBackend?: CooldownBackend; // 'database' or 'memory' for cooldown management
};

export class MarketScanner {
    private running = false;
    private timer: NodeJS.Timeout | null = null;
    private scanCount = 0;
    private lastAlertAt: Record<string, number> = {};

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
    ) {}

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

    stop(): void {
        this.running = false;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

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

    private async processSymbol(symbol: string): Promise<void> {
        const ohlcv = this.exchange.getOHLCV(symbol);
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

        await this.processDatabaseAlerts(symbol, signal, currentPrice);
    }

    private async processTradeSignal(symbol: string, signal: TradeSignal, currentPrice: number): Promise<void> {
        if (this.opts.requireAtrFeasibility !== false) {
            const atr = this.strategy.lastAtr;
            if (atr && atr > 0) {
                const atrMovePct = (3 * atr / currentPrice) * 100;
                if (atrMovePct < this.strategy.riskRewardTarget) return;
            }
        }

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

    private async processDatabaseAlerts(
        symbol: string,
        signal: TradeSignal,
        currentPrice: number
    ): Promise<void> {
        const alerts = await dbService.getAlertsBySymbol(symbol);
        const now = Date.now();
        const cooldownMs = this.opts.cooldownMs ?? 5 * 60_000;

        for (const alert of alerts) {
            if (this.opts.cooldownBackend === 'database') {
                if (alert.lastAlertAt && now - alert.lastAlertAt < cooldownMs) continue;
            } else {
                const last = this.lastAlertAt[symbol] ?? 0;
                if (now - last < cooldownMs) continue;
                this.lastAlertAt[symbol] = now;
            }

            let triggered = false;
            let triggerReason = '';

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
                if (this.opts.cooldownBackend === 'database') {
                    await dbService.updateAlertStatus(alert.id, 'triggered');
                    await dbService.setLastAlertTime(alert.id, now);
                }

                const msg = [
                    `🔔 Alert Triggered: ${symbol}`,
                    `• Condition: ${triggerReason}`,
                    `• Signal: ${signal.signal.toUpperCase()}`,
                    `• Price: $${currentPrice.toFixed(4)}`,
                    `• Indicators: ${signal.reason.join(', ')}`,
                    `• ROI Est: ${this.strategy.lastAtr ? ((3 * this.strategy.lastAtr / currentPrice) * 100).toFixed(2) + '%' : 'N/A'}`,
                    alert.note ? `• Note: ${alert.note}` : ''
                ].filter(Boolean).join('\n');

                await this.telegram.sendMessage(msg)
                    .catch(err => {
                        logger.error('Failed to send Telegram alert', { error: err });
                    });
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
                await new Promise((r) => setTimeout(r, 300 * (i + 1)));
            }
        }
        throw err;
    }
}
