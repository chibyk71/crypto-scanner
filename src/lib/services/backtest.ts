// src/lib/backtest.ts

/**
 * Improved backtesting module to simulate trading performance using historical OHLCV data.
 * - Proper entry/exit fee handling (entry fee applied on entry, exit fee applied on exit)
 * - Allocation reserved on entry and restored on exit
 * - Candle path-based SL/TP hit ordering to avoid lookahead bias
 * - Equity curve + per-bar returns for correct Sharpe calculation
 * - Additional metrics: profit factor, expectancy, payoff ratio, time-in-market
 * - Minor resampling fixes (rounding)
 */
import { Strategy, StrategyInput, TradeSignal } from '../strategy';
import type { OhlcvData } from '../../types';

export interface BacktestResult {
    initialCapital: number;
    finalCapital: number;
    totalPnL: number; // percent
    totalTrades: number;
    winningTrades: number;
    winRate: number; // percent
    maxDrawdown: number; // percent
    avgTradePnL: number; // percent (of initial capital)
    sharpeRatio: number;
    avgHoldTime: number; // In minutes
    trades: TradeLog[];
    signalStats?: { buysGenerated: number; sellsGenerated: number; holdsGenerated: number };
    equityCurve?: { time: number; equity: number }[];
    profitFactor?: number;
    expectancy?: number; // percent of initial capital per trade
    payoffRatio?: number;
    timeInMarketPercent?: number;
    grossProfit?: number;
    grossLoss?: number;
}

export interface TradeLog {
    entryTime: number;
    exitTime: number;
    signal: 'buy' | 'sell';
    entryPrice: number;
    exitPrice: number;
    positionSize: number; // in asset units (can be negative)
    allocatedCapital: number; // capital allocated (reserved) at entry
    pnL: number; // absolute $ PnL (after fees)
    pnLPercentOfInitial: number; // PnL as percent of initial capital
    reasons: string[];
    stopLoss?: number;
    takeProfit?: number;
    exitReason?: string;
}

export interface BacktestConfig {
    initialCapital: number;
    positionSizePercent: number; // fraction of capital to allocate per trade, e.g. 0.02 for 2%
    feePercent: number; // percent (applied on entry and exit)
    slippagePercent: number; // percent applied to fills
    spreadPercent: number; // additional spread adjustment on entry
    cooldownMinutes: number;
}

/** Resample 3m OHLCV to HTF (e.g., 1h) */
function resampleToHTF(primaryData: OhlcvData, timeframeMinutes: number = 60): OhlcvData {
    const { timestamps, highs, lows, closes, volumes, opens } = primaryData;
    const result: OhlcvData = { timestamps: [], highs: [], lows: [], closes: [], volumes: [], opens: [], length: 0 };
    const barsPerHTF = Math.max(1, Math.round(timeframeMinutes / 3)); // rounding to nearest integer

    for (let i = 0; i < timestamps.length; i += barsPerHTF) {
        const sliceEnd = Math.min(i + barsPerHTF, timestamps.length);
        const sliceHighs = highs.slice(i, sliceEnd);
        const sliceLows = lows.slice(i, sliceEnd);
        const sliceCloses = closes.slice(i, sliceEnd);
        const sliceOpens = opens.slice(i, sliceEnd);
        const sliceVolumes = volumes.slice(i, sliceEnd);
        const sliceTimestamps = timestamps.slice(i, sliceEnd);

        if (sliceTimestamps.length === 0) continue;

        result.timestamps.push(sliceTimestamps[sliceTimestamps.length - 1]);
        result.highs.push(Math.max(...sliceHighs));
        result.lows.push(Math.min(...sliceLows));
        result.closes.push(sliceCloses[sliceCloses.length - 1]);
        result.opens.push(sliceOpens[0]);
        result.volumes.push(sliceVolumes.reduce((s, v) => s + v, 0));
    }
    result.length = result.timestamps.length;
    return result;
}

/** Helper: simulate the intra-candle price path to decide which level (SL or TP) hit first.
 * We assume:
 *  - If candle is bullish (close >= open): path = open -> high -> low -> close
 *  - If candle is bearish (close < open): path = open -> low -> high -> close
 * This is a deterministic, common approximation (not perfect but avoids lookahead).
 */
function firstHitInCandle(open: number, high: number, low: number, close: number, levels: number[]) {
    // levels: array of numeric levels to check (e.g., [stopLoss, takeProfit]) - return first touched level or null
    const path: number[] = [];
    if (close >= open) {
        path.push(high, low, close);
    } else {
        path.push(low, high, close);
    }

    // simulate that price starts at open and then moves to each path point in sequence;
    // a level is hit if it's between the previous point and the next point inclusive.
    let prev = open;
    for (const point of path) {
        for (const level of levels) {
            // If level lies between prev and point (inclusive), we consider it hit
            if ((level >= Math.min(prev, point) && level <= Math.max(prev, point))) {
                return level;
            }
        }
        prev = point;
    }
    return null;
}

export function runBacktest(
    symbol: string,
    primaryData: OhlcvData,
    config: BacktestConfig,
    strategy: Strategy
): BacktestResult {
    const {
        initialCapital,
        positionSizePercent,
        feePercent,
        slippagePercent,
        spreadPercent,
        cooldownMinutes,
    } = config;

    // Basic validation
    const N = primaryData.timestamps.length;
    if (
        N < 200 ||
        primaryData.highs.length !== N ||
        primaryData.lows.length !== N ||
        primaryData.closes.length !== N ||
        primaryData.opens.length !== N ||
        primaryData.volumes.length !== N
    ) {
        throw new Error('Insufficient or invalid primary OHLCV data');
    }

    const htfData = resampleToHTF(primaryData, 60);
    if (htfData.timestamps.length < 200) {
        throw new Error('Insufficient HTF data after resampling');
    }

    let capital = initialCapital;
    let reservedCapital = 0; // capital currently reserved for open position(s)
    let maxCapitalSeen = initialCapital;
    let maxDrawdown = 0;
    const trades: TradeLog[] = [];
    const equityCurve: { time: number; equity: number }[] = [];
    const perBarReturns: number[] = []; // returns computed from equity curve per bar
    let lastExitTime = -Infinity;
    let openTrade: {
        entryTime: number;
        signal: 'buy' | 'sell';
        entryPrice: number;
        positionSize: number;
        allocatedCapital: number;
        stopLoss?: number;
        takeProfit?: number;
        reasons: string[];
    } | null = null;

    let buysGenerated = 0;
    let sellsGenerated = 0;
    let holdsGenerated = 0;

    // Precompute bars per HTF ratio to pick HTF slices later
    const barsPerHTF = Math.max(1, Math.round(60 / 3)); // 20 for 1h on 3m bars

    // Start loop from index 200 to ensure enough data for indicators (as original)
    for (let i = 200; i < N; i++) {
        const timestamp = primaryData.timestamps[i];
        const open = primaryData.opens[i];
        const high = primaryData.highs[i];
        const low = primaryData.lows[i];
        const close = primaryData.closes[i];

        // Build StrategyInput (slices up to current bar inclusive)
        const input: StrategyInput = {
            symbol,
            primaryData: {
                timestamps: primaryData.timestamps.slice(0, i + 1),
                highs: primaryData.highs.slice(0, i + 1),
                lows: primaryData.lows.slice(0, i + 1),
                closes: primaryData.closes.slice(0, i + 1),
                volumes: primaryData.volumes.slice(0, i + 1),
                opens: primaryData.opens.slice(0, i + 1),
                length: i + 1,
            },
            htfData: {
                timestamps: htfData.timestamps.slice(0, Math.floor(i / barsPerHTF) + 1),
                highs: htfData.highs.slice(0, Math.floor(i / barsPerHTF) + 1),
                lows: htfData.lows.slice(0, Math.floor(i / barsPerHTF) + 1),
                closes: htfData.closes.slice(0, Math.floor(i / barsPerHTF) + 1),
                volumes: htfData.volumes.slice(0, Math.floor(i / barsPerHTF) + 1),
                opens: htfData.opens.slice(0, Math.floor(i / barsPerHTF) + 1),
                length: Math.floor(i / barsPerHTF) + 1,
            },
            price: close,
            atrMultiplier: strategy.atrMultiplier,
            riskRewardTarget: strategy.riskRewardTarget,
            trailingStopPercent: strategy.trailingStopPercent,
        };

        // Skip if in cooldown
        if (timestamp < lastExitTime + cooldownMinutes * 60 * 1000) {
            // push equity point for this bar (no trade decision)
            equityCurve.push({ time: timestamp, equity: capital + reservedCapital });
            const prevEquity = equityCurve.length > 1 ? equityCurve[equityCurve.length - 2].equity : capital;
            perBarReturns.push((capital + reservedCapital) / prevEquity - 1);
            continue;
        }

        // Generate signal
        const signal = strategy.generateSignal(input);
        if (signal.signal === 'buy') buysGenerated++;
        else if (signal.signal === 'sell') sellsGenerated++;
        else holdsGenerated++;

        // If there is an open trade, evaluate exit conditions inside this candle
        if (openTrade) {
            let exitPrice: number | undefined;
            let exitReason = '';

            const stopLevel = openTrade.stopLoss;
            const takeLevel = openTrade.takeProfit;

            // 1) Check intra-candle hits (SL/TP). Determine which level is hit first in this candle path.
            if (stopLevel !== undefined && takeLevel !== undefined) {
                const levelsToCheck = [stopLevel, takeLevel];
                const firstHit = firstHitInCandle(open, high, low, close, levelsToCheck);
                if (firstHit !== null) {
                    // Adjust for slippage depending on direction of trade and type of level
                    if (openTrade.signal === 'buy') {
                        if (firstHit === stopLevel) {
                            // buyer stops out -> likely filled at stopLevel plus slippage
                            exitPrice = Math.min(stopLevel * (1 + slippagePercent / 100), high); // conservative
                            exitReason = 'Stop-loss hit';
                        } else if (firstHit === takeLevel) {
                            exitPrice = Math.max(takeLevel * (1 - slippagePercent / 100), low);
                            exitReason = 'Take-profit hit';
                        }
                    } else {
                        // sell position
                        if (firstHit === stopLevel) {
                            exitPrice = Math.max(stopLevel * (1 - slippagePercent / 100), low);
                            exitReason = 'Stop-loss hit';
                        } else if (firstHit === takeLevel) {
                            exitPrice = Math.min(takeLevel * (1 + slippagePercent / 100), high);
                            exitReason = 'Take-profit hit';
                        }
                    }
                }
            }

            // 2) If reversal signal appears (opposite direction), exit at current bar close adjusted for slippage
            if (!exitPrice) {
                if ((openTrade.signal === 'buy' && signal.signal === 'sell') ||
                    (openTrade.signal === 'sell' && signal.signal === 'buy')) {
                    // exit at a conservative fill price (close with slippage)
                    exitPrice = close * (openTrade.signal === 'buy' ? (1 - slippagePercent / 100) : (1 + slippagePercent / 100));
                    exitReason = 'Reversal signal';
                }
            }

            // If exit was triggered, close the trade
            if (exitPrice !== undefined) {
                const usdEntryValue = openTrade.allocatedCapital;
                const usdExitValue = Math.abs(openTrade.positionSize) * exitPrice;
                // entry fee was already deducted at entry (we tracked entryFee), apply exit fee now
                const exitFee = usdExitValue * (feePercent / 100);

                // compute raw PnL based on direction
                const rawPnL = openTrade.signal === 'buy'
                    ? (exitPrice - openTrade.entryPrice) * openTrade.positionSize
                    : (openTrade.entryPrice - exitPrice) * openTrade.positionSize;

                const pnL = rawPnL - exitFee; // entry fee already accounted earlier by subtracting it from capital when opening

                // Restore allocation and add PnL to capital
                capital += openTrade.allocatedCapital; // release reserved capital back
                reservedCapital -= openTrade.allocatedCapital;
                capital += pnL; // add PnL (may be negative)
                maxCapitalSeen = Math.max(maxCapitalSeen, capital);
                const drawdown = (maxCapitalSeen - capital) / maxCapitalSeen * 100;
                maxDrawdown = Math.max(maxDrawdown, drawdown);

                // finalize trade log
                const tradePnLPercent = (pnL / initialCapital) * 100;
                trades.push({
                    entryTime: openTrade.entryTime,
                    exitTime: timestamp,
                    signal: openTrade.signal,
                    entryPrice: openTrade.entryPrice,
                    exitPrice,
                    positionSize: openTrade.positionSize,
                    allocatedCapital: openTrade.allocatedCapital,
                    pnL,
                    pnLPercentOfInitial: tradePnLPercent,
                    reasons: openTrade.reasons.concat([exitReason]),
                    stopLoss: openTrade.stopLoss,
                    takeProfit: openTrade.takeProfit,
                    exitReason,
                });

                lastExitTime = timestamp;
                openTrade = null;
            }
        }

        // Update mark-to-market drawdown while trade is open (conservative update)
        if (openTrade) {
            const currentPrice = close;
            const rawPnL = openTrade.signal === 'buy'
                ? (currentPrice - openTrade.entryPrice) * openTrade.positionSize
                : (openTrade.entryPrice - currentPrice) * openTrade.positionSize;
            const currentCapital = capital + reservedCapital + rawPnL;
            const drawdown = (maxCapitalSeen - currentCapital) / maxCapitalSeen * 100;
            maxDrawdown = Math.max(maxDrawdown, drawdown);
        }

        // Open new trade if none open and signal valid and SL/TP provided
        if (!openTrade && signal.signal !== 'hold' && signal.stopLoss !== undefined && signal.takeProfit !== undefined) {
            // compute allocation and position size
            const allocation = capital * positionSizePercent * (signal.positionSizeMultiplier ?? 1);
            if (allocation <= 0) {
                // nothing to allocate
            } else {
                // compute entry price with slippage & spread applied conservatively
                const entryPrice = signal.signal === 'buy'
                    ? close * (1 + slippagePercent / 100 + spreadPercent / 100)
                    : close * (1 - slippagePercent / 100 - spreadPercent / 100);

                const positionSize = allocation / entryPrice; // asset units

                if (positionSize > 0) {
                    // apply entry fee now (deduct from capital)
                    const entryUsdValue = allocation;
                    const entryFee = entryUsdValue * (feePercent / 100);
                    capital -= entryFee;
                    // reserve allocation (we remove from free capital while trade is open)
                    capital -= allocation;
                    reservedCapital += allocation;

                    openTrade = {
                        entryTime: timestamp,
                        signal: signal.signal,
                        entryPrice,
                        positionSize: signal.signal === 'buy' ? positionSize : positionSize, // direction encoded in signal
                        allocatedCapital: allocation,
                        stopLoss: signal.stopLoss,
                        takeProfit: signal.takeProfit,
                        reasons: signal.reason,
                    };

                    // Immediately track equity after opening
                    maxCapitalSeen = Math.max(maxCapitalSeen, capital + reservedCapital);
                }
            }
        }

        // push equity curve point at current bar (total equity = cash + reserved capital + mark-to-market unrealized)
        let currentEquity = capital + reservedCapital;
        if (openTrade) {
            // compute unrealized PnL at close price
            const currentPrice = close;
            const unrealized = openTrade.signal === 'buy'
                ? (currentPrice - openTrade.entryPrice) * openTrade.positionSize
                : (openTrade.entryPrice - currentPrice) * openTrade.positionSize;
            currentEquity += unrealized;
        }
        equityCurve.push({ time: timestamp, equity: currentEquity });

        // compute per-bar return relative to previous equity point (if exists)
        if (equityCurve.length > 1) {
            const prev = equityCurve[equityCurve.length - 2].equity;
            const r = prev > 0 ? (currentEquity / prev - 1) : 0;
            perBarReturns.push(r);
        } else {
            perBarReturns.push(0);
        }
    }

    // If an open trade remains at the end, close it at last close price conservatively and include exit fees
    if (openTrade) {
        const lastIdx = N - 1;
        const timestamp = primaryData.timestamps[lastIdx];
        const finalPrice = primaryData.closes[lastIdx];
        const exitPrice = finalPrice * (openTrade.signal === 'buy' ? (1 - slippagePercent / 100) : (1 + slippagePercent / 100));
        const usdExitValue = Math.abs(openTrade.positionSize) * exitPrice;
        const exitFee = usdExitValue * (feePercent / 100);

        const rawPnL = openTrade.signal === 'buy'
            ? (exitPrice - openTrade.entryPrice) * openTrade.positionSize
            : (openTrade.entryPrice - exitPrice) * openTrade.positionSize;
        const pnL = rawPnL - exitFee;

        // restore allocation and add PnL
        capital += openTrade.allocatedCapital;
        reservedCapital -= openTrade.allocatedCapital;
        capital += pnL;

        maxCapitalSeen = Math.max(maxCapitalSeen, capital);
        const drawdown = (maxCapitalSeen - capital) / maxCapitalSeen * 100;
        maxDrawdown = Math.max(maxDrawdown, drawdown);

        trades.push({
            entryTime: openTrade.entryTime,
            exitTime: timestamp,
            signal: openTrade.signal,
            entryPrice: openTrade.entryPrice,
            exitPrice,
            positionSize: openTrade.positionSize,
            allocatedCapital: openTrade.allocatedCapital,
            pnL,
            pnLPercentOfInitial: (pnL / initialCapital) * 100,
            reasons: openTrade.reasons.concat(['Forced close at end']),
            stopLoss: openTrade.stopLoss,
            takeProfit: openTrade.takeProfit,
            exitReason: 'EOD close',
        });

        openTrade = null;
    }

    // Metrics calculations
    const totalPnL = ((capital - initialCapital) / initialCapital) * 100;
    const totalTrades = trades.length;
    const winningTrades = trades.filter(t => t.pnL > 0).length;
    const winRate = totalTrades > 0 ? (winningTrades / totalTrades * 100) : 0;
    const avgTradePnL = totalTrades > 0 ? (trades.reduce((s, t) => s + t.pnLPercentOfInitial, 0) / totalTrades) : 0;
    const avgHoldTime = totalTrades > 0 ? (trades.reduce((s, t) => s + (t.exitTime - t.entryTime) / 1000 / 60, 0) / totalTrades) : 0;

    // Sharpe: use per-bar returns -> annualize properly
    const barsPerDay = (24 * 60) / 3; // 480 bars/day for 3-minute bars
    const barsPerYear = 365 * barsPerDay; // use 365 for crypto
    const meanBarReturn = perBarReturns.length > 0 ? perBarReturns.reduce((s, r) => s + r, 0) / perBarReturns.length : 0;
    const stdBarReturn = perBarReturns.length > 1 ? Math.sqrt(perBarReturns.reduce((s, r) => s + Math.pow(r - meanBarReturn, 2), 0) / (perBarReturns.length - 1)) : 0;
    const riskFreeRateAnnual = 0.02; // 2% annual
    // annualized Sharpe = (mean_bar * barsPerYear - rf) / (std_bar * sqrt(barsPerYear))
    const sharpeRatio = stdBarReturn > 0
        ? ((meanBarReturn * barsPerYear) - riskFreeRateAnnual) / (stdBarReturn * Math.sqrt(barsPerYear))
        : 0;

    // Profit Factor, Expectancy, Payoff Ratio
    const grossProfit = trades.filter(t => t.pnL > 0).reduce((s, t) => s + t.pnL, 0);
    const grossLoss = trades.filter(t => t.pnL < 0).reduce((s, t) => s + t.pnL, 0); // negative
    const profitFactor = grossLoss < 0 ? (grossProfit / Math.abs(grossLoss)) : (grossProfit > 0 ? Infinity : 0);

    const avgWin = trades.filter(t => t.pnL > 0).length > 0 ? trades.filter(t => t.pnL > 0).reduce((s, t) => s + t.pnL, 0) / trades.filter(t => t.pnL > 0).length : 0;
    const avgLoss = trades.filter(t => t.pnL < 0).length > 0 ? trades.filter(t => t.pnL < 0).reduce((s, t) => s + t.pnL, 0) / trades.filter(t => t.pnL < 0).length : 0; // negative
    const payoffRatio = avgLoss !== 0 ? (avgWin / Math.abs(avgLoss)) : (avgWin > 0 ? Infinity : 0);

    const expectancy = totalTrades > 0
        ? ((winningTrades / totalTrades) * (avgWin / initialCapital * 100) + ((totalTrades - winningTrades) / totalTrades) * (avgLoss / initialCapital * 100))
        : 0;

    const totalTime = primaryData.timestamps[primaryData.timestamps.length - 1] - primaryData.timestamps[0];
    const timeInMarketMs = trades.reduce((s, t) => s + (t.exitTime - t.entryTime), 0);
    const timeInMarketPercent = totalTime > 0 ? (timeInMarketMs / totalTime) * 100 : 0;

    return {
        initialCapital,
        finalCapital: capital,
        totalPnL,
        totalTrades,
        winningTrades,
        winRate,
        maxDrawdown,
        avgTradePnL,
        sharpeRatio,
        avgHoldTime,
        trades,
        signalStats: { buysGenerated, sellsGenerated, holdsGenerated },
        equityCurve,
        profitFactor,
        expectancy,
        payoffRatio,
        timeInMarketPercent,
        grossProfit,
        grossLoss,
    };
}
