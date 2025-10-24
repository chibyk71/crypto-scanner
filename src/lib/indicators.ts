// src/lib/indicators.ts

import * as ti from 'technicalindicators';
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
 * @param period - RSI period (default: 10).
 * @returns Array of RSI values.
 */
export function calculateRSI(values: number[], period: number = 10): number[] {
    if (values.length < period) return [];
    return ti.rsi({ values, period });
}

/**
 * Calculates Moving Average Convergence Divergence (MACD).
 * @param values - Array of price data.
 * @param fastPeriod - Fast EMA period (default: 5).
 * @param slowPeriod - Slow EMA period (default: 13).
 * @param signalPeriod - Signal line period (default: 8).
 * @returns Array of MACDOutput objects (may contain undefined fields per library typings).
 */
export function calculateMACD(
    values: number[],
    fastPeriod: number = 5,
    slowPeriod: number = 13,
    signalPeriod: number = 8
): {MACD: number, signal: number, histogram: number}[] {
    if (values.length < slowPeriod) return [];
    let result = ti.macd({ values, fastPeriod, slowPeriod, signalPeriod, SimpleMAOscillator: false, SimpleMASignal: false });

    // make sure no fields is undefined if any relace them with a default value
    result = result.map(macd => ({
        MACD: macd.MACD ?? 0,
        signal: macd.signal ?? 0,
        histogram: macd.histogram ?? 0,
    }));

    return result as {MACD: number, signal: number, histogram: number}[];
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
 * @param period - ATR period (default: 12).
 * @returns Array of ATR values.
 */
export function calculateATR(highs: number[], lows: number[], closes: number[], period: number = 12): number[] {
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
 * Calculates Volume Weighted Moving Average (VWMA) manually.
 * @param closes - Array of closing prices.
 * @param volumes - Array of volumes.
 * @param period - VWMA period (default: 20).
 * @returns Array of VWMA values.
 */
export function calculateVWMA(closes: number[], volumes: number[], period: number = 20): number[] {
    if (closes.length < period || volumes.length < period) return [];
    if (closes.length !== volumes.length) {
        throw new Error('Closes and volumes must have equal length');
    }

    const vwma: number[] = [];
    for (let i = period - 1; i < closes.length; i++) {
        let priceVolumeSum = 0;
        let volumeSum = 0;
        for (let j = 0; j < period; j++) {
            const idx = i - j;
            priceVolumeSum += closes[idx] * volumes[idx];
            volumeSum += volumes[idx];
        }
        // Avoid division by zero
        if (volumeSum === 0) {
            vwma.push(0);
        } else {
            vwma.push(priceVolumeSum / volumeSum);
        }
    }
    return vwma;
}

/**
 * Calculates Volume Weighted Average Price (VWAP).
 * @param highs - Array of high prices.
 * @param lows - Array of low prices.
 * @param closes - Array of closing prices.
 * @param volumes - Array of volumes.
 * @param period - VWAP period (default: 20).
 * @returns Array of VWAP values.
 */
export function calculateVWAP(highs: number[], lows: number[], closes: number[], volumes: number[], period: number = 20): number[] {
    if (highs.length < period || lows.length < period || closes.length < period || volumes.length < period) return [];
    if (highs.length !== lows.length || lows.length !== closes.length || closes.length !== volumes.length) {
        throw new Error('Input arrays must have equal length');
    }
    return ti.vwap({ high: highs, low: lows, close: closes, volume: volumes });
}
