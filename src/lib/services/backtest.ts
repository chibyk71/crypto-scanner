/**
 * BacktestService runs backtests on historical OHLCV data using a provided strategy.
 * Supports multi-timeframe data, technical indicators, and realistic trade simulation.
 */

import { ExchangeService } from './exchange';
import { Strategy, TradeSignal, StrategyInput } from '../strategy';
import { createLogger } from '../logger';
import { config } from '../config/settings';
import type { OhlcvData } from '../../types';

const logger = createLogger('BacktestService');

/**
 * The structure for the final output of the backtest.
 */
export interface BacktestResult {
    symbol: string;
    timeframe: string;
    initialCapital: number;
    finalCapital: number;
    totalPnLPercent: number;
    totalTrades: number;
    winningTrades: number;
    losingTrades: number;
    maxDrawdownPercent: number;
    trades: Trade[];
}

/**
 * Represents a single executed trade in the backtest.
 */
interface Trade {
    entryTime: number;
    exitTime?: number;
    entryPrice: number;
    exitPrice?: number;
    type: 'buy' | 'sell';
    status: 'closed' | 'open';
    pnlPercent: number;
    size: number; // Capital allocated to the trade
    stopLoss?: number;   // NEW: Store calculated SL price
    takeProfit?: number; // NEW: Store calculated TP price
}


export class BacktestService {
    private exchange: ExchangeService;
    private strategy: Strategy;

    constructor(exchange: ExchangeService, strategy: Strategy) {
        this.exchange = exchange;
        this.strategy = strategy;
    }

    /**
     * Converts timeframe string to milliseconds (e.g., '1h' -> 3600000).
     */
    private timeframeToMs(timeframe: string): number {
        const units: { [key: string]: number } = {
            '1m': 60 * 1000,
            '3m': 3 * 60 * 1000,
            '5m': 5 * 60 * 1000,
            '15m': 15 * 60 * 1000,
            '30m': 30 * 60 * 1000,
            '1h': 60 * 60 * 1000,
            '4h': 4 * 60 * 60 * 1000,
            '1d': 24 * 60 * 60 * 1000,
            '1w': 7 * 24 * 60 * 60 * 1000,
        };
        const match = timeframe.match(/^(\d+)([mhdw])$/);
        if (!match) throw new Error(`Invalid timeframe: ${timeframe}`);
        const value = parseInt(match[1]);
        const unit = match[2];
        return value * units[`1${unit}`];
    }

    /**
     * Runs the backtest over historical data.
     * @param symbol - The symbol (e.g., 'BTC/USDT').
     * @param timeframe - The primary timeframe (e.g., '3m').
     * @param initialCapital - Starting equity.
     * @param limit - Number of historical candles to fetch.
     * @returns The backtest performance metrics.
     */
    public async runBacktest(
        symbol: string,
        timeframe: string = config.scanner.primaryTimeframe || '3m',
        initialCapital: number = 1000,
        limit: number = 5000
    ): Promise<BacktestResult | null> {
        logger.info(`Starting backtest for ${symbol}:${timeframe} with ${initialCapital} capital over ${limit} candles.`);

        // Validate symbol
        if (!await this.exchange.validateSymbol(symbol)) {
            logger.error(`Symbol ${symbol} not supported by exchange.`);
            return null;
        }

        // Validate timeframe
        const validTimeframes = ['1m', '3m', '5m', '15m', '30m', '1h', '4h', '1d', '1w'];
        if (!validTimeframes.includes(timeframe)) {
            logger.error(`Invalid timeframe: ${timeframe}. Supported: ${validTimeframes.join(', ')}`);
            return null;
        }

        // Calculate since timestamp for historical data
        const timeframeMs = this.timeframeToMs(timeframe);
        const since = Date.now() - (limit * timeframeMs);

        logger.info(`Fetching historical data since ${new Date(since).toISOString()}`);

        // Fetch historical data
        const primaryCandles: OhlcvData = await this.exchange.fetchHistoricalOHLCV(symbol, timeframe, limit);
        if (!primaryCandles || primaryCandles.length < limit) {
            logger.error(`Insufficient data for ${symbol}:${timeframe}. Need ${limit} candles, got ${primaryCandles?.length || 0}.`);
            return null;
        }

        // Fetch higher timeframe data if required
        const higherTimeframe = config.scanner.htfTimeframe || '1h';
        let higherCandles: OhlcvData = { timestamps: [], opens: [], highs: [], lows: [], closes: [], volumes: [], length: 0 };
        if (higherTimeframe !== timeframe) {
            const higherLimit = Math.ceil(limit * (timeframeMs / this.timeframeToMs(higherTimeframe)));
            higherCandles = await this.exchange.fetchHistoricalOHLCV(symbol, higherTimeframe, higherLimit);
            if (!higherCandles || higherCandles.length < higherLimit) {
                logger.warn(`Insufficient higher timeframe data for ${symbol}:${higherTimeframe}. Got ${higherCandles?.length || 0} candles, needed ${higherLimit}. Proceeding with primary timeframe only.`);
                higherCandles = { timestamps: [], opens: [], highs: [], lows: [], closes: [], volumes: [], length: 0 };
            }
        }

        const requiredHistory = config.historyLength || 200;
        if (primaryCandles.length < requiredHistory) {
            logger.error(`Insufficient data. Need at least ${requiredHistory} candles, got ${primaryCandles.length}.`);
            return null;
        }

        // Setup simulation parameters
        const candlesToSimulate = primaryCandles.timestamps.slice(requiredHistory);
        let currentCapital = initialCapital;
        const trades: Trade[] = [];
        let openTrade: Trade | null = null;
        const equityCurve: number[] = [initialCapital];
        let peakEquity = initialCapital;
        let maxDrawdown = 0;
        const positionSizePercent = 0.1; // 10% of capital per trade
        const feePercent = 0.1; // 0.1% trading fee per side
        const slippagePercent = 0.05; // 0.05% slippage

        // Main simulation loop
        for (let i = 0; i < candlesToSimulate.length; i++) {
            const fullIndex = requiredHistory + i;
            const timestamp = primaryCandles.timestamps[fullIndex];
            const closePrice = primaryCandles.closes[fullIndex];
            const highPrice = primaryCandles.highs[fullIndex];
            const lowPrice = primaryCandles.lows[fullIndex];

            if (!timestamp || closePrice === undefined) {
                logger.warn(`Skipping candle at index ${fullIndex} due to missing timestamp or close price.`);
                continue;
            }

            // Get corresponding higher timeframe candle
            let higherMarketData: OhlcvData | null = null;
            if (higherCandles.length > 0) {
                // Find the higher timeframe candle that covers the current primary candle's timestamp
                const higherIndex = higherCandles.timestamps.findIndex(
                    (t, idx) => t <= timestamp && (idx + 1 >= higherCandles.length || higherCandles.timestamps[idx + 1] > timestamp)
                );
                if (higherIndex >= 0) {
                    higherMarketData = {
                        symbol,
                        timestamps: higherCandles.timestamps.slice(0, higherIndex + 1),
                        opens: higherCandles.opens.slice(0, higherIndex + 1),
                        highs: higherCandles.highs.slice(0, higherIndex + 1),
                        lows: higherCandles.lows.slice(0, higherIndex + 1),
                        closes: higherCandles.closes.slice(0, higherIndex + 1),
                        volumes: higherCandles.volumes.slice(0, higherIndex + 1),
                        length: higherIndex + 1,
                    };
                }
            }

            // Prepare market data for strategy
            const primaryMarketData: OhlcvData = {
                symbol,
                timestamps: primaryCandles.timestamps.slice(0, fullIndex),
                opens: primaryCandles.opens.slice(0, fullIndex),
                highs: primaryCandles.highs.slice(0, fullIndex),
                lows: primaryCandles.lows.slice(0, fullIndex),
                closes: primaryCandles.closes.slice(0, fullIndex),
                volumes: primaryCandles.volumes.slice(0, fullIndex),
                length: fullIndex,
            };

            const strategyInput: StrategyInput = {
                primaryData: primaryMarketData,
                htfData: higherMarketData || { timestamps: [], opens: [], highs: [], lows: [], closes: [], volumes: [], length: 0 },
                symbol,
                price: closePrice,
                atrMultiplier: this.strategy.atrMultiplier, // Use strategy's configured multiplier (1.5)
                riskRewardTarget: this.strategy.riskRewardTarget, // Use strategy's configured RRR (3)
                trailingStopPercent: this.strategy.trailingStopPercent, // Use strategy's configured trailing stop (3)
            };

            // Generate signal
            const signal: TradeSignal = this.strategy.generateSignal(strategyInput);

            // Trade management logic
            if (openTrade) {
                let isClosed = false;
                let exitPrice = closePrice; // Default exit price is the close

                // 1. Check for Stop-Loss and Take-Profit (Using High/Low for more realistic execution)
                if (openTrade.type === 'buy' && openTrade.stopLoss && openTrade.takeProfit) {
                    if (lowPrice <= openTrade.stopLoss) {
                        isClosed = true;
                        exitPrice = openTrade.stopLoss; // SL hit price
                    } else if (highPrice >= openTrade.takeProfit) {
                        isClosed = true;
                        exitPrice = openTrade.takeProfit; // TP hit price
                    } else if (signal.signal === 'sell') {
                        // 2. Check for Reversal Signal
                        isClosed = true;
                        exitPrice = closePrice; // Exit at the bar's close price
                    }
                } else if (openTrade.type === 'sell' && openTrade.stopLoss && openTrade.takeProfit) {
                    if (highPrice >= openTrade.stopLoss) {
                        isClosed = true;
                        exitPrice = openTrade.stopLoss; // SL hit price
                    } else if (lowPrice <= openTrade.takeProfit) {
                        isClosed = true;
                        exitPrice = openTrade.takeProfit; // TP hit price
                    } else if (signal.signal === 'buy') {
                        // 2. Check for Reversal Signal
                        isClosed = true;
                        exitPrice = closePrice; // Exit at the bar's close price
                    }
                }

                // 3. Execute closure
                if (isClosed) {
                    // Apply slippage to the exit price (SL price, TP price, or Close price)
                    const finalExitPrice = exitPrice * (1 + (openTrade.type === 'buy' ? slippagePercent : -slippagePercent) / 100);

                    openTrade = this.closeTrade(openTrade, finalExitPrice, timestamp, feePercent);
                    trades.push(openTrade);
                    currentCapital += openTrade.size * (openTrade.pnlPercent / 100);
                    openTrade = null;
                }
            }

            // Open a new trade
            if (!openTrade && signal.confidence >= 65 && (signal.signal === 'buy' || signal.signal === 'sell')) {
                const size = currentCapital * positionSizePercent;
                openTrade = {
                    entryTime: timestamp,
                    // Apply slippage to entry price
                    entryPrice: closePrice * (1 + (signal.signal === 'buy' ? slippagePercent : -slippagePercent) / 100),
                    type: signal.signal,
                    status: 'open',
                    pnlPercent: 0,
                    size,
                    // NEW: Store dynamic risk management values
                    stopLoss: signal.stopLoss,
                    takeProfit: signal.takeProfit,
                };
                currentCapital -= size * (feePercent / 100); // Deduct entry fee
            }

            // Update equity curve and drawdown
             const currentEquity = openTrade
                ? currentCapital + openTrade.size * (((closePrice * (1 + (openTrade.type === 'buy' ? -slippagePercent : slippagePercent) / 100) - openTrade.entryPrice) / openTrade.entryPrice) * (openTrade.type === 'buy' ? 1 : -1))
                : currentCapital;
            equityCurve.push(currentEquity);
            peakEquity = Math.max(peakEquity, currentEquity);
            maxDrawdown = Math.max(maxDrawdown, (peakEquity - currentEquity) / peakEquity);
        }

        // Finalize open trade
        if (openTrade) {
            const finalPrice = primaryCandles.closes[primaryCandles.length - 1] * (1 + (openTrade.type === 'buy' ? -slippagePercent : slippagePercent) / 100);
            const finalTimestamp = primaryCandles.timestamps[primaryCandles.length - 1];
            openTrade = this.closeTrade(openTrade, finalPrice, finalTimestamp, feePercent);
            trades.push(openTrade);
            currentCapital += openTrade.size * (openTrade.pnlPercent / 100);
        }

        // Calculate final results
        const totalPnLPercent = ((currentCapital - initialCapital) / initialCapital) * 100;
        const winningTrades = trades.filter(t => t.pnlPercent > 0).length;
        const losingTrades = trades.filter(t => t.pnlPercent <= 0).length;

        const result: BacktestResult = {
            symbol,
            timeframe,
            initialCapital,
            finalCapital: currentCapital,
            totalPnLPercent,
            totalTrades: trades.length,
            winningTrades,
            losingTrades,
            maxDrawdownPercent: maxDrawdown * 100,
            trades,
        };

        logger.info(`Backtest completed for ${symbol}:${timeframe}`, {
            totalPnLPercent: result.totalPnLPercent.toFixed(2),
            totalTrades: result.totalTrades,
            winRate: result.totalTrades > 0 ? ((winningTrades / result.totalTrades) * 100).toFixed(2) : '0.00',
            maxDrawdownPercent: result.maxDrawdownPercent.toFixed(2),
        });

        return result;
    }

    /**
     * Closes a trade and calculates PNL with fees.
     */
    private closeTrade(trade: Trade, exitPrice: number, exitTime: number, feePercent: number): Trade {
        const rawPnl = (exitPrice - trade.entryPrice) / trade.entryPrice;
        const feeMultiplier = 1 - (2 * feePercent) / 100; // Entry and exit fees
        trade.pnlPercent = rawPnl * 100 * (trade.type === 'buy' ? 1 : -1) * feeMultiplier;
        trade.exitPrice = exitPrice;
        trade.exitTime = exitTime;
        trade.status = 'closed';
        return trade;
    }
}
