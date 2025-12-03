// src/lib/indicators.ts
// =============================================================================
// PRODUCTION-GRADE TECHNICAL INDICATORS SUITE
// Pure functions – no side effects, no external state
// Used by: Strategy, MLService, AlertEvaluator, simulateTrade
// All functions return full arrays (aligned with input length where possible)
// =============================================================================

import * as ti from 'technicalindicators';
import type { ADXOutput } from 'technicalindicators/declarations/directionalmovement/ADX';
import type { StochasticOutput } from 'technicalindicators/declarations/momentum/Stochastic';
import type { MACDOutput } from 'technicalindicators/declarations/moving_averages/MACD';
import type { BollingerBandsOutput } from 'technicalindicators/declarations/volatility/BollingerBands';

// -----------------------------------------------------------------------------
// 1. HELPER: Safe array slice for indicators that drop early values
// -----------------------------------------------------------------------------
// function trimToLength<T>(arr: T[], targetLength: number): T[] {
//     return arr.length >= targetLength ? arr.slice(-targetLength) : arr;
// }

// -----------------------------------------------------------------------------
// 2. BASIC MOVING AVERAGES
// -----------------------------------------------------------------------------
export function calculateSMA(values: number[], period: number = 50): number[] {
    if (values.length < period) return [];
    return ti.sma({ values, period });
}

export function calculateEMA(values: number[], period: number = 50): number[] {
    if (values.length < period) return [];
    return ti.ema({ values, period });
}

// -----------------------------------------------------------------------------
// 3. MOMENTUM & STRENGTH
// -----------------------------------------------------------------------------
export function calculateRSI(values: number[], period: number = 14): number[] {
    if (values.length < period + 1) return [];
    return ti.rsi({ values, period });
}

export function calculateMomentum(closes: number[], period: number = 10): number[] {
    if (closes.length < period + 1) return [];
    const result: number[] = [];
    for (let i = period; i < closes.length; i++) {
        result.push(closes[i] - closes[i - period]);
    }
    return result;
}

// -----------------------------------------------------------------------------
// 4. MACD – FULLY TYPED & CLEANED
// -----------------------------------------------------------------------------
export function calculateMACD(
    values: number[],
    fastPeriod = 5,
    slowPeriod = 13,
    signalPeriod = 8
): MACDOutput[] {
    if (values.length < slowPeriod + signalPeriod) return [];

    const raw = ti.macd({
        values,
        fastPeriod,
        slowPeriod,
        signalPeriod,
        SimpleMAOscillator: false,
        SimpleMASignal: false,
    });

    // Clean any undefined fields (library sometimes returns partial objects)
    return raw.map(item => ({
        MACD: item.MACD ?? 0,
        signal: item.signal ?? 0,
        histogram: item.histogram ?? 0,
    }));
}

// -----------------------------------------------------------------------------
// 5. STOCHASTIC OSCILLATOR
// -----------------------------------------------------------------------------
export function calculateStochastic(
    highs: number[],
    lows: number[],
    closes: number[],
    kPeriod = 14,
    dPeriod = 3
): StochasticOutput[] {
    if (highs.length < kPeriod || lows.length < kPeriod || closes.length < kPeriod) return [];
    if (![highs, lows, closes].every(arr => arr.length === highs.length)) {
        throw new Error('OHLC arrays must have equal length');
    }

    return ti.stochastic({
        high: highs,
        low: lows,
        close: closes,
        period: kPeriod,
        signalPeriod: dPeriod,

    });
}

// -----------------------------------------------------------------------------
// 6. AVERAGE TRUE RANGE (ATR)
// -----------------------------------------------------------------------------
export function calculateATR(
    highs: number[],
    lows: number[],
    closes: number[],
    period = 14
): number[] {
    if (highs.length < period || lows.length < period || closes.length < period) return [];
    return ti.atr({ high: highs, low: lows, close: closes, period });
}

// -----------------------------------------------------------------------------
// 7. BOLLINGER BANDS – CRITICAL FOR VOLATILITY FILTERING
// -----------------------------------------------------------------------------
export function calculateBollingerBands(
    values: number[],
    period = 20,
    stdDev = 2
): BollingerBandsOutput[] {
    if (values.length < period) return [];
    return ti.bollingerbands({
        values,
        period,
        stdDev,
    });
}

// -----------------------------------------------------------------------------
// 8. VOLUME-BASED INDICATORS
// -----------------------------------------------------------------------------
export function calculateOBV(closes: number[], volumes: number[]): number[] {
    if (closes.length !== volumes.length || closes.length < 2) return [];

    const obv: number[] = [0];
    for (let i = 1; i < closes.length; i++) {
        if (closes[i] > closes[i - 1]) {
            obv.push(obv[i - 1] + volumes[i]);
        } else if (closes[i] < closes[i - 1]) {
            obv.push(obv[i - 1] - volumes[i]);
        } else {
            obv.push(obv[i - 1]);
        }
    }
    return obv;
}

export function calculateVWMA(closes: number[], volumes: number[], period: number = 20): number[] {
    if (closes.length < period || closes.length !== volumes.length) return [];

    const vwma: number[] = [];
    for (let i = period - 1; i < closes.length; i++) {
        let priceVolumeSum = 0;
        let volumeSum = 0;
        for (let j = 0; j < period; j++) {
            const idx = i - j;
            priceVolumeSum += closes[idx] * volumes[idx];
            volumeSum += volumes[idx];
        }
        vwma.push(volumeSum === 0 ? closes[i] : priceVolumeSum / volumeSum);
    }
    return vwma;
}

export function calculateVWAP(
    highs: number[],
    lows: number[],
    closes: number[],
    volumes: number[],
    period?: number
): number[] {
    // VWAP is session-based in real trading, but we approximate with rolling window
    // If no period → use entire history (true VWAP)
    const limit = period ?? highs.length;
    if (highs.length < limit) return [];

    return ti.vwap({
        high: highs,
        low: lows,
        close: closes,
        volume: volumes,
    });
}

// -----------------------------------------------------------------------------
// 9. TREND STRENGTH: ADX
// -----------------------------------------------------------------------------
export function calculateADX(
    highs: number[],
    lows: number[],
    closes: number[],
    period = 14
): ADXOutput[] {
    if (highs.length < period + 1) return [];
    return ti.adx({ high: highs, low: lows, close: closes, period });
}

// -----------------------------------------------------------------------------
// 10. CANDLESTICK PATTERN: ENGULFING
// -----------------------------------------------------------------------------
export type EngulfingPattern = 'bullish' | 'bearish' | null;

export function detectEngulfing(
    opens: number[],
    highs: number[],
    lows: number[],
    closes: number[]
): EngulfingPattern[] {
    if (opens.length < 2) return [];

    const result: EngulfingPattern[] = [null]; // index 0 unused

    for (let i = 1; i < opens.length; i++) {
        const prev = {
            open: opens[i - 1],
            close: closes[i - 1],
            high: highs[i - 1],
            low: lows[i - 1],
        };
        const curr = {
            open: opens[i],
            close: closes[i],
            high: highs[i],
            low: lows[i],
        };

        const prevBearish = prev.close < prev.open;
        const currBullish = curr.close > curr.open;
        const prevBullish = prev.close > prev.open;
        const currBearish = curr.close < curr.open;

        const bullishEngulf =
            prevBearish &&
            currBullish &&
            curr.open <= prev.close &&
            curr.close >= prev.open;

        const bearishEngulf =
            prevBullish &&
            currBearish &&
            curr.open >= prev.close &&
            curr.close <= prev.open;

        result.push(bullishEngulf ? 'bullish' : bearishEngulf ? 'bearish' : null);
    }

    return result;
}

// -----------------------------------------------------------------------------
// EXPORT SUMMARY (for easy import elsewhere)
// -----------------------------------------------------------------------------
export const Indicators = {
    calculateSMA,
    calculateEMA,
    calculateRSI,
    calculateMACD,
    calculateStochastic,
    calculateATR,
    calculateBollingerBands,
    calculateOBV,
    calculateVWMA,
    calculateVWAP,
    calculateMomentum,
    calculateADX,
    detectEngulfing,
};
