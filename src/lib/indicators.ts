import * as ti from 'technicalindicators';

/**
 * =========================
 * TREND INDICATORS
 * =========================
 */

/**
 * Exponential Moving Average (EMA)
 * Commonly used for dynamic support/resistance and trend detection.
 *
 * @param closes - Closing price series.
 * @param period - Lookback period (default: 200 for long-term trend).
 * @returns Array of EMA values.
 */
export function calculateEMA(closes: number[], period: number = 200): number[] {
    return ti.ema({ values: closes, period }) as number[];
}

/**
 * Simple Moving Average (SMA)
 * Useful for baseline trend confirmation.
 *
 * @param closes - Closing price series.
 * @param period - Lookback period.
 * @returns Array of SMA values.
 */
export function calculateSMA(closes: number[], period: number): number[] {
    return ti.sma({ values: closes, period }) as number[];
}

/**
 * Moving Average Crossover
 * Returns true if the short-term MA crosses above/below the long-term MA.
 */
export function checkMACrossover(shortMA: number[], longMA: number[]): 'bullish' | 'bearish' | 'none' {
    if (shortMA.length < 2 || longMA.length < 2) return 'none';
    const prevCross = shortMA[shortMA.length - 2] - longMA[longMA.length - 2];
    const currentCross = shortMA[shortMA.length - 1] - longMA[longMA.length - 1];
    if (prevCross <= 0 && currentCross > 0) return 'bullish';
    if (prevCross >= 0 && currentCross < 0) return 'bearish';
    return 'none';
}

/**
 * =========================
 * MOMENTUM INDICATORS
 * =========================
 */

/**
 * Relative Strength Index (RSI)
 * Detects overbought (>70) and oversold (<30) conditions.
 */
export function calculateRSI(closes: number[], period: number = 14): number[] {
    return ti.rsi({ values: closes, period }) as number[];
}

/**
 * Moving Average Convergence Divergence (MACD)
 * Shows momentum shifts via MACD line, Signal line, and Histogram.
 */
export function calculateMACD(
    closes: number[],
    fastPeriod: number = 12,
    slowPeriod: number = 26,
    signalPeriod: number = 9
): Array<{ MACD: number; signal: number; histogram: number }> {
    return ti.macd({
        values: closes,
        fastPeriod,
        slowPeriod,
        signalPeriod,
        SimpleMAOscillator: false,
        SimpleMASignal: false,
    }) as Array<{ MACD: number; signal: number; histogram: number }>;
}

/**
 * Stochastic Oscillator
 * Detects momentum shifts in ranging markets.
 */
export function calculateStochastic(
    highs: number[],
    lows: number[],
    closes: number[],
    period: number = 14,
    signalPeriod: number = 3
): Array<{ k: number; d: number }> {
    return ti.stochastic({
        high: highs,
        low: lows,
        close: closes,
        period,
        signalPeriod,
    }) as Array<{ k: number; d: number }>;
}

/**
 * =========================
 * VOLATILITY INDICATORS
 * =========================
 */

/**
 * Average True Range (ATR)
 * Measures volatility, useful for dynamic stop-loss sizing.
 */
export function calculateATR(
    highs: number[],
    lows: number[],
    closes: number[],
    period: number = 14
): number[] {
    return ti.atr({ high: highs, low: lows, close: closes, period }) as number[];
}

/**
 * Bollinger Bands
 * Identifies volatility squeezes and breakout potential.
 */
export function calculateBollingerBands(
    closes: number[],
    period: number = 20,
    stdDev: number = 2
): Array<{ lower: number; middle: number; upper: number }> {
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
 * Confirms trend strength via cumulative volume flow.
 */
export function calculateOBV(closes: number[], volumes: number[]): number[] {
    return ti.obv({ close: closes, volume: volumes }) as number[];
}

/**
 * Volume Weighted Average Price (VWAP)
 * Common intraday reference point (requires time-aligned OHLCV).
 */
export function calculateVWAP(highs: number[], lows: number[], closes: number[], volumes: number[]): number[] {
    const vwap: number[] = [];
    let cumulativeVolume = 0;
    let cumulativePV = 0;

    for (let i = 0; i < closes.length; i++) {
        const typicalPrice = (highs[i] + lows[i] + closes[i]) / 3;
        cumulativeVolume += volumes[i];
        cumulativePV += typicalPrice * volumes[i];
        vwap.push(cumulativePV / cumulativeVolume);
    }

    return vwap;
}
