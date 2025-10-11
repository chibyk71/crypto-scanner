// src/index.backtest.ts

/**
 * Entry point for running a backtest on historical OHLCV data.
 * Fetches data via ExchangeService and executes backtest with Strategy.
 */
import { config } from './lib/config/settings';
import { createLogger } from './lib/logger';
import { runBacktest, type BacktestConfig } from './lib/services/backtest';
import { ExchangeService } from './lib/services/exchange';
import { Strategy } from './lib/strategy';
import type { OhlcvData } from './types';

const logger = createLogger('index.backtest');

async function main() {
    // Configurable parameters from settings or defaults
    const backtestConfig: BacktestConfig = {
        initialCapital: 1000,
        positionSizePercent: 0.1,
        feePercent:  0.1,
        slippagePercent: 0.05,
        spreadPercent: 0.05,
        cooldownMinutes: 5,
    };

    const symbol = config.symbols[4] ?? 'BTC/USDT';
    const timeframe = config.scanner.primaryTimeframe ?? '3m';
    const candleLimit = 30*24*60/3; // 30 days of 3m candles;

    // Strategy config for flexibility
    const strategyOptions = {
        rsiPeriod: 10,
        adxThreshold: 25,
        minMomentumConfirms: 1, // Lowered for more trades
    };

    try {
        logger.info('Initializing backtest', { symbol, timeframe, candleLimit });

        // Initialize strategy and exchange
        const strategy = new Strategy(3, strategyOptions);
        const exchange = new ExchangeService();

        // Fetch historical data
        logger.info(`Fetching ${candleLimit} candles for ${symbol}:${timeframe}`);
        const primaryData: OhlcvData = await exchange.fetchHistoricalOHLCV(symbol, timeframe, candleLimit);

        // Validate data
        if (primaryData.timestamps.length === 0) {
            logger.error('No historical data fetched for backtest');
            process.exit(1);
        }
        if (
            primaryData.highs.some(h => isNaN(h) || h <= 0) ||
            primaryData.lows.some(l => isNaN(l) || l <= 0) ||
            primaryData.closes.some(c => isNaN(c) || c <= 0) ||
            primaryData.volumes.some(v => isNaN(v) || v < 0)
        ) {
            logger.error('Invalid OHLCV data: Contains NaN or negative values');
            process.exit(1);
        }
        if (primaryData.timestamps.length < 200) {
            logger.error(`Insufficient data: ${primaryData.timestamps.length} candles, need at least 200`);
            process.exit(1);
        }

        logger.info(`Fetched ${primaryData.timestamps.length} candles for ${symbol}:${timeframe}`);

        // Run backtest
        const result = runBacktest(symbol, primaryData, backtestConfig, strategy);
        logger.info('Backtest completed', {
            result: {
                ...result,
                trades: result.trades.map(t => ({
                    entryTime: new Date(t.entryTime).toISOString(),
                    exitTime: new Date(t.exitTime).toISOString(),
                    signal: t.signal,
                    entryPrice: t.entryPrice.toFixed(2),
                    exitPrice: t.exitPrice.toFixed(2),
                    positionSize: t.positionSize.toFixed(6),
                    pnL: t.pnL.toFixed(2),
                    reasons: t.reasons,
                })),
            },
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
