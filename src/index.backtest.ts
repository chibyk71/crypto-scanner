import { config } from "./lib/config/settings";
import { createLogger } from "./lib/logger";
import { BacktestService } from "./lib/services/backtest";
import { ExchangeService } from "./lib/services/exchange";
import { Strategy } from "./lib/strategy";

const logger = createLogger('index.backtest');

async function main() {
    try {
        const exchange = new ExchangeService();
        const strategy = new Strategy();
        const backtestService = new BacktestService(exchange, strategy);

        await backtestService.runBacktest(config.symbols[9], '3m', 100, 5000).then(result => {
            logger.info('Backtest completed', { result });
        }).catch(err => {
            logger.error('Backtest failed', { error: err.message, stack: err.stack });
        });
    } catch (err: any) {
        logger.error('Worker encountered a fatal error', { error: err.message, stack: err.stack });
        process.exit(1);
    }
}

main().catch(err => {
    logger.error('Unhandled error in main', { error: err.message, stack: err.stack });
    process.exit(1);
});
