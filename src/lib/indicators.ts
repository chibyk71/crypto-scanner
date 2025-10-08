// src/lib/indicators.ts

import * as ti from 'technicalindicators';
import type { StochasticOutput } from 'technicalindicators/declarations/momentum/Stochastic';

/**
 * =========================
 * UTILITY TYPES
 * =========================
 */
// Define custom types for clarity (assuming these are in '../types' or similar)
type ClosePrices = number[];
type HighPrices = number[];
type LowPrices = number[];
type Volumes = number[];

/**
 * =========================
 * TREND INDICATORS
 * =========================
 */

/**
 * Exponential Moving Average (EMA)
 * @param closes - Closing price series.
 * @param period - Lookback period (Default: 200 for long-term trend, or 20 for short-term).
 * @returns Array of EMA values.
 */
export function calculateEMA(closes: ClosePrices, period: number = 200): number[] {
    if (closes.length < period) return [];
    return ti.ema({ values: closes, period }) as number[];
}

/**
 * Simple Moving Average (SMA)
 * @param closes - Closing price series.
 * @param period - Lookback period (Default: 50).
 * @returns Array of SMA values.
 */
export function calculateSMA(closes: ClosePrices, period: number = 50): number[] {
    if (closes.length < period) return [];
    return ti.sma({ values: closes, period }) as number[];
}

/**
 * Moving Average Crossover Check
 * NOTE: This function's logic remains intact as it doesn't take a period, but uses the results of MA functions.
 */
export function checkMACrossover(shortMA: number[], longMA: number[]): 'bullish' | 'bearish' | 'none' {
    if (shortMA.length < 2 || longMA.length < 2) return 'none';

    // Check if the latest short MA is above the long MA
    const lastShort = shortMA.at(-1)!;
    const lastLong = longMA.at(-1)!;

    // Check if the crossover occurred on the last bar
    const prevShort = shortMA.at(-2)!;
    const prevLong = longMA.at(-2)!;

    if (lastShort > lastLong && prevShort <= prevLong) {
        return 'bullish'; // Bullish Crossover
    }
    if (lastShort < lastLong && prevShort >= prevLong) {
        return 'bearish'; // Bearish Crossover
    }
    if (lastShort > lastLong) {
        return 'bullish'; // Trend aligned bullish
    }
    if (lastShort < lastLong) {
        return 'bearish'; // Trend aligned bearish
    }

    return 'none';
}

/**
 * Moving Average Convergence Divergence (MACD)
 * @param closes - Closing price series.
 * @param fastPeriod - Fast EMA period (Default: 5 for fast trading, or 12 standard).
 * @param slowPeriod - Slow EMA period (Default: 13 for fast trading, or 26 standard).
 * @param signalPeriod - Signal line period (Default: 8 for fast trading, or 9 standard).
 * @returns Object containing macd, signal, and histogram arrays.
 */
export function calculateMACD(
    closes: ClosePrices,
    fastPeriod: number = 5,    // Suggested fast setting for 3m chart
    slowPeriod: number = 13,   // Suggested fast setting for 3m chart
    signalPeriod: number = 8   // Suggested fast setting for 3m chart
) {
    const period = Math.max(fastPeriod, slowPeriod, signalPeriod);
    if (closes.length < period) return [{ MACD: 0, signal: 0, histogram: 0 }];

    return ti.macd({
        values: closes,
        fastPeriod,
        slowPeriod,
        signalPeriod,
        SimpleMAOscillator: false,
        SimpleMASignal: false,
    });
}


/**
 * =========================
 * MOMENTUM INDICATORS
 * =========================
 */

/**
 * Relative Strength Index (RSI)
 * @param closes - Closing price series.
 * @param period - Lookback period (Default: 10 for fast trading, or 14 standard).
 * @returns Array of RSI values.
 */
export function calculateRSI(closes: ClosePrices, period: number = 10): number[] {
    if (closes.length < period) return [];
    return ti.rsi({ values: closes, period }) as number[];
}

/**
 * Stochastic Oscillator
 * @param highs - High price series.
 * @param lows - Low price series.
 * @param closes - Closing price series.
 * @param period - %K period (Default: 14).
 * @param signalPeriod - %D period (Default: 3).
 * @returns Object containing %K and %D arrays.
 */
export function calculateStochastic(
    highs: HighPrices,
    lows: LowPrices,
    closes: ClosePrices,
    period: number = 14,
    signalPeriod: number = 3
): StochasticOutput[] {
    if (highs.length < period || lows.length < period || closes.length < period) {
        return [{ k: 0, d: 0 }];
    }

    return ti.stochastic({
        high: highs,
        low: lows,
        close: closes,
        period,
        signalPeriod,
    });
}

/**
 * =========================
 * VOLATILITY INDICATORS
 * =========================
 */

/**
 * Average True Range (ATR)
 * @param highs - High price series.
 * @param lows - Low price series.
 * @param closes - Closing price series.
 * @param period - Lookback period (Default: 12 for fast trading, or 14 standard).
 * @returns Array of ATR values.
 */
export function calculateATR(highs: HighPrices, lows: LowPrices, closes: ClosePrices, period: number = 12): number[] {
    if (highs.length < period || lows.length < period || closes.length < period) return [];
    return ti.atr({ high: highs, low: lows, close: closes, period }) as number[];
}

/**
 * Bollinger Bands (BB)
 * @param closes - Closing price series.
 * @param period - Lookback period (Default: 20).
 * @param stdDev - Standard deviation multiplier (Default: 2).
 * @returns Array of objects with lower, middle, and upper band values.
 */
export function calculateBollingerBands(closes: ClosePrices, period: number = 20, stdDev: number = 2) {
    if (closes.length < period) return [];
    return ti.bollingerbands({
        values: closes,
        period,
        stdDev,
    }) as Array<{ lower: number; middle: number; upper: number }>;
}


/**
 * =========================
 * VOLUME-BASED INDICATORS
 * =========================
 */

/**
 * On-Balance Volume (OBV)
 * @param closes - Closing price series.
 * @param volumes - Volume series.
 * @returns Array of OBV values.
 */
export function calculateOBV(closes: ClosePrices, volumes: Volumes): number[] {
    if (closes.length !== volumes.length || closes.length === 0) return [];
    return ti.obv({ close: closes, volume: volumes }) as number[];
}

/**
 * Volume Weighted Average Price (VWAP)
 * NOTE: VWAP does not take a 'period' and typically uses all data since the start of the session.
 */
export function calculateVWAP(highs: HighPrices, lows: LowPrices, closes: ClosePrices, volumes: Volumes): number[] {
    const vwap: number[] = [];
    let cumulativeVolume = 0;
    let cumulativePV = 0;

    for (let i = 0; i < closes.length; i++) {
        const typicalPrice = (highs[i] + lows[i] + closes[i]) / 3;
        const PV = typicalPrice * volumes[i];

        cumulativeVolume += volumes[i];
        cumulativePV += PV;

        if (cumulativeVolume > 0) {
            vwap.push(cumulativePV / cumulativeVolume);
        } else {
            vwap.push(vwap.length > 0 ? vwap.at(-1)! : typicalPrice); // Push previous VWAP or typical price
        }
    }
    return vwap;
}
