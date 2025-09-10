import { ExchangeService } from './services/exchange';
import { Strategy } from './strategy';
import { config } from './config/settings';
import { MarketScanner } from './scanner-github';
import { TelegramService } from './services/telegram';
import { createLogger, format, transports } from 'winston';
import { dbService } from './db';

export const logger = createLogger({
    level: 'info',
    format: format.combine(format.timestamp(), format.json()),
    transports: [new transports.Console()]
});

export async function startWorker(): Promise<void> {
    const lock = await dbService.getLock();
    if (lock) {
        logger.warn('Bot already running, skipping execution');
        return;
    }
    await dbService.setLock(true);

    const exchange = new ExchangeService();
    const strategy = new Strategy(3);
    const telegram = new TelegramService();
    try {
        await exchange.initialize(config.symbols);
        logger.info('Exchange initialized', { symbols: config.symbols });
        const scanner = new MarketScanner(exchange, strategy, config.symbols, telegram, {
            concurrency: 1,
            cooldownMs: 5 * 60_000,
            jitterMs: 250,
            retries: 1,
            requireAtrFeasibility: true
        });
        await scanner.runSingleScan();
        logger.info('Worker completed', { symbols: config.symbols });
    } catch (err) {
        logger.error('Worker failed', { error: err });
        throw err;
    } finally {
        await dbService.setLock(false);
    }
}
