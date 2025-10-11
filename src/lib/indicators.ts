/**
 * Technical indicators for trading analysis, using the technicalindicators library.
 * Includes SMA, EMA, RSI, MACD, Stochastic, ATR, Bollinger Bands, OBV, and ADX calculations.
 */
import * as ti from 'technicalindicators';
import type { ADXOutput } from 'technicalindicators/declarations/directionalmovement/ADX';
import type { StochasticOutput } from 'technicalindicators/declarations/momentum/Stochastic';
import type { MACDOutput } from 'technicalindicators/declarations/moving_averages/MACD';
import type { BollingerBandsOutput } from 'technicalindicators/declarations/volatility/BollingerBands';

/**
 * Calculates Simple Moving Average (SMA).
 * @param values - Array of price data.
 * @param period - SMA period (default: 50).
 * @returns Array of SMA values.
 */
export function calculateSMA(values: number[], period: number = 50): number[] {
    if (values.length < period) return [];
    return ti.sma({ values, period });
}

/**
 * Calculates Exponential Moving Average (EMA).
 * @param values - Array of price data.
 * @param period - EMA period (default: 50).
 * @returns Array of EMA values.
 */
export function calculateEMA(values: number[], period: number = 50): number[] {
    if (values.length < period) return [];
    return ti.ema({ values, period });
}

/**
 * Calculates Relative Strength Index (RSI).
 * @param values - Array of price data.
 * @param period - RSI period (default: 14).
 * @returns Array of RSI values.
 */
export function calculateRSI(values: number[], period: number = 14): number[] {
    if (values.length < period) return [];
    return ti.rsi({ values, period });
}

/**
 * Calculates Moving Average Convergence Divergence (MACD).
 * @param values - Array of price data.
 * @param fastPeriod - Fast EMA period (default: 12).
 * @param slowPeriod - Slow EMA period (default: 26).
 * @param signalPeriod - Signal line period (default: 9).
 * @returns Array of MACD objects with MACD, signal, and histogram.
 */
export function calculateMACD(
    values: number[],
    fastPeriod: number = 12,
    slowPeriod: number = 26,
    signalPeriod: number = 9
): MACDOutput[] {
    if (values.length < slowPeriod) return [{ MACD: 0, signal: 0, histogram: 0 }];
    return ti.macd({ values, fastPeriod, slowPeriod, signalPeriod, SimpleMAOscillator: false, SimpleMASignal: false });
}

/**
 * Calculates Stochastic Oscillator.
 * @param highs - Array of high prices.
 * @param lows - Array of low prices.
 * @param closes - Array of closing prices.
 * @param kPeriod - %K period (default: 14).
 * @param dPeriod - %D period (default: 3).
 * @returns Array of Stochastic objects with k and d values.
 */
export function calculateStochastic(
    highs: number[],
    lows: number[],
    closes: number[],
    kPeriod: number = 14,
    dPeriod: number = 3
): StochasticOutput[] {
    if (highs.length < kPeriod || lows.length < kPeriod || closes.length < kPeriod) return [];
    if (highs.length !== lows.length || lows.length !== closes.length) {
        throw new Error('Input arrays (highs, lows, closes) must have equal length');
    }
    return ti.stochastic({ high: highs, low: lows, close: closes, period: kPeriod, signalPeriod: dPeriod });
}

/**
 * Calculates Average True Range (ATR).
 * @param highs - Array of high prices.
 * @param lows - Array of low prices.
 * @param closes - Array of closing prices.
 * @param period - ATR period (default: 14).
 * @returns Array of ATR values.
 */
export function calculateATR(highs: number[], lows: number[], closes: number[], period: number = 14): number[] {
    if (highs.length < period || lows.length < period || closes.length < period) return [];
    if (highs.length !== lows.length || lows.length !== closes.length) {
        throw new Error('Input arrays (highs, lows, closes) must have equal length');
    }
    return ti.atr({ high: highs, low: lows, close: closes, period });
}

/**
 * Calculates Bollinger Bands.
 * @param values - Array of price data.
 * @param period - Period for SMA (default: 20).
 * @param stdDev - Standard deviation multiplier (default: 2).
 * @returns Array of Bollinger Bands objects with upper, middle, and lower bands.
 */
export function calculateBollingerBands(values: number[], period: number = 20, stdDev: number = 2): BollingerBandsOutput[] {
    if (values.length < period) return [];
    return ti.bollingerbands({ values, period, stdDev });
}

/**
 * Calculates On-Balance Volume (OBV).
 * @param closes - Array of closing prices.
 * @param volumes - Array of volume data.
 * @returns Array of OBV values.
 */
export function calculateOBV(closes: number[], volumes: number[]): number[] {
    if (closes.length < 2 || volumes.length < 2 || closes.length !== volumes.length) return [];
    return ti.obv({ close: closes, volume: volumes });
}

/**
 * Checks for Moving Average crossover signals.
 * @param shortMA - Array of short-term MA values.
 * @param longMA - Array of long-term MA values.
 * @returns 'bullish', 'bearish', or 'none' based on crossover detection.
 */
export function checkMACrossover(shortMA: number[], longMA: number[]): 'bullish' | 'bearish' | 'none' {
    if (shortMA.length < 2 || longMA.length < 2 || shortMA.length !== longMA.length) return 'none';
    const lastShort = shortMA.at(-1)!;
    const prevShort = shortMA.at(-2)!;
    const lastLong = longMA.at(-1)!;
    const prevLong = longMA.at(-2)!;

    if (lastShort > lastLong && prevShort <= prevLong) {
        return 'bullish';
    } else if (lastShort < lastLong && prevShort >= prevLong) {
        return 'bearish';
    } else if (lastShort > lastLong) {
        return 'bullish'; // Trend continuation
    } else if (lastShort < lastLong) {
        return 'bearish'; // Trend continuation
    }
    return 'none';
}

/**
 * Calculates Average Directional Index (ADX).
 * @param highs - Array of high prices.
 * @param lows - Array of low prices.
 * @param closes - Array of closing prices.
 * @param period - ADX period (default: 14).
 * @returns Array of ADX objects with adx, pdi (+DI), and mdi (-DI) values.
 */
export function calculateADX(highs: number[], lows: number[], closes: number[], period: number = 14): ADXOutput[] {
    if (highs.length < period || lows.length < period || closes.length < period) return [];
    if (highs.length !== lows.length || lows.length !== closes.length) {
        throw new Error('Input arrays (highs, lows, closes) must have equal length');
    }
    return ti.adx({ high: highs, low: lows, close: closes, period });
}