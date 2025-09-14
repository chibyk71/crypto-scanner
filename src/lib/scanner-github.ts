import { ExchangeService } from './services/exchange';
import { TelegramService } from './services/telegram';
import { dbService } from './db';
import { Strategy, type TradeSignal } from './strategy';
import { createLogger } from './logger';

const logger = createLogger('MarketScanner');

type ScannerOptions = {
    concurrency: number;
    cooldownMs?: number;
    jitterMs?: number;
    retries?: number;
    requireAtrFeasibility?: boolean;
    heartbeatCycles?: number; // Number of cycles between heartbeat messages
};

export class MarketScanner {
    constructor(
        private readonly exchange: ExchangeService,
        private readonly strategy: Strategy,
        private readonly symbols: string[],
        private readonly telegram: TelegramService,
        private readonly opts: ScannerOptions = {
            concurrency: 3,
            cooldownMs: 5 * 60_000,
            jitterMs: 250,
            retries: 1,
            requireAtrFeasibility: true,
            heartbeatCycles: 60 // Default to 60 cycles
        }
    ) {}

    /**
     * Runs a single scan cycle over all symbols, processing them concurrently.
     * Sends a Telegram heartbeat message every heartbeatCycles (default 60) cycles,
     * tracked via the database to persist across restarts.
     */
    async runSingleScan(): Promise<void> {
        const { concurrency, jitterMs = 0, retries = 1, heartbeatCycles = 60 } = this.opts;

        // Increment the heartbeat cycle count
        const cycleCount = await dbService.incrementHeartbeatCount();
        logger.info(`Scan cycle ${cycleCount} started`, { symbols: this.symbols });

        // Process symbols concurrently
        const queue = [...this.symbols];
        const workers = Array.from(
            { length: Math.min(concurrency, queue.length) },
            () => this.processWorker(queue, jitterMs, retries)
        );
        await Promise.all(workers);

        // Send heartbeat message if cycle count is a multiple of heartbeatCycles
        if (cycleCount % heartbeatCycles === 0) {
            await this.telegram.sendMessage(`Heartbeat: Scan completed over ${this.symbols.length} symbols`)
                .catch(err => {
                    logger.error('Failed to send Telegram heartbeat message', { error: err });
                });
            await dbService.resetHeartbeatCount();
            logger.info(`Heartbeat sent and cycle count reset at cycle ${cycleCount}`);
        }

        logger.info(`Scan cycle ${cycleCount} completed`);
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
        if (!ohlcv || ohlcv.length < 200) {
            logger.warn(`Insufficient OHLCV data for ${symbol}`, { candles: ohlcv?.length || 0 });
            return;
        }

        const highs = ohlcv.map(c => Number(c[2])).filter(v => !isNaN(v));
        const lows = ohlcv.map(c => Number(c[3])).filter(v => !isNaN(v));
        const closes = ohlcv.map(c => Number(c[4])).filter(v => !isNaN(v));
        const volumes = ohlcv.map(c => Number(c[5])).filter(v => !isNaN(v));
        if (closes.length < 200) {
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

        const alerts = await dbService.getAlertsBySymbol(symbol);
        const now = Date.now();
        const cooldownMs = this.opts.cooldownMs ?? 5 * 60_000;
        if (alerts.some(a => a.lastAlertAt && now - a.lastAlertAt < cooldownMs)) return;

        for (const alert of alerts) {
            await dbService.setLastAlertTime(alert.id, now);
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
            if (alert.lastAlertAt && now - alert.lastAlertAt < cooldownMs) continue;

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
                await dbService.updateAlertStatus(alert.id, 'triggered');
                await dbService.setLastAlertTime(alert.id, now);

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
