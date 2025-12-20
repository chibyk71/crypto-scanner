// src/lib/utils/indicatorUtils.ts
// =============================================================================
// INDICATOR UTILITIES – SINGLE SOURCE OF TRUTH FOR ALL TECHNICAL INDICATORS
//
// Purpose:
//   • Centralize all indicator calculations in one place
//   • Eliminate code duplication between Strategy and MLService
//   • Ensure identical indicator values across the entire system
//   • Properly handle both primary timeframe (e.g., 3m) and higher timeframe (e.g., 1h)
//
// Key Features:
//   • Returns full series arrays AND convenient "last" values for quick access
//   • Computes HTF indicators (EMA-50, RSI, ADX) when htfData is provided
//   • Safe fallbacks for missing/short data (prevents crashes on startup)
//   • All periods are hard-coded for consistency but can be made configurable later
// =============================================================================

import {
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
} from '../indicators';
import type { OhlcvData } from '../../types';

/**
 * Complete map of all indicators used throughout the bot
 *
 * Primary timeframe: fast signals (e.g., 3-minute candles)
 * HTF: higher timeframe trend filter (e.g., 1-hour candles)
 * last: most recent values for quick decision-making (most code only needs these)
 */
export interface IndicatorMap {
    // === Raw OHLCV data (primary timeframe) ===
    close: number[];
    high: number[];
    low: number[];
    open: number[];
    volume: number[];

    // === Primary timeframe moving averages ===
    sma: number[];                    // Simple Moving Average (20-period)
    emaShort: number[];               // EMA-20 (fast trend)
    emaMid: number[];                 // EMA-50 (medium trend)
    emaLong: number[];                // EMA-200 (long-term trend)
    vwma: number[];                   // Volume-Weighted Moving Average (20-period)
    vwap: number[];                   // Volume-Weighted Average Price (session-based)

    // === Primary timeframe oscillators & momentum ===
    rsi: number[];                    // Relative Strength Index (14-period)
    momentum: number[];               // Price momentum (10-period change)
    stochastic: { k: number[]; d: number[] };  // %K and %D lines
    macd: {
        line: number[];
        signal: number[];
        histogram: number[];
    };

    // === Primary timeframe volatility ===
    atr: number[];                    // Average True Range (14-period)
    bollingerBands: {
        upper: number[];
        middle: number[];
        lower: number[];
        bandwidth: number[];          // (upper - lower) / middle * 100 → market volatility
        percentB: number[];           // Position within BB (0-1) → overbought/oversold
    };

    // === Primary timeframe volume & patterns ===
    obv: number[];                    // On-Balance Volume
    engulfing: ('bullish' | 'bearish' | null)[];  // Engulfing candle detection

    // === Higher Timeframe (HTF) indicators – CRITICAL for trend filtering ===
    htfEmaMid: number[];              // EMA-50 on 1h timeframe (main trend filter)
    htfRsi: number[];                 // RSI on 1h (longer-term momentum)
    htfAdx: {                         // ADX + DI lines on 1h (trend strength & direction)
        adx: number[];
        pdi: number[];                // +DI (bullish strength)
        mdi: number[];                // -DI (bearish strength)
    };

    // === Latest values – most code only needs these for decision making ===
    last: {
        // Primary timeframe latest
        close: number;
        rsi: number;
        emaShort: number;
        emaMid: number;
        emaLong: number;
        atr: number;
        macdLine: number;
        macdSignal: number;
        macdHistogram: number;
        bbUpper: number;
        bbMiddle: number;
        bbLower: number;
        bbBandwidth: number;
        percentB: number;
        stochasticK: number;
        stochasticD: number;
        momentum: number;
        engulfing: 'bullish' | 'bearish' | null;
        vwap: number;
        vwma: number;
        obv: number;

        // HTF latest values – used heavily in strategy for trend confirmation
        htfEmaMid: number;
        htfRsi: number;
        htfAdx: number;
        htfPdi: number;
        htfMdi: number;
    };
}

/**
 * Main function: Compute ALL indicators from OHLCV data
 *
 * @param primary - Fast timeframe data (required – e.g., 3m candles)
 * @param htf     - Higher timeframe data (optional – e.g., 1h candles)
 * @returns       - Complete IndicatorMap with full series + latest values
 *
 * Why this design?
 *   • One function call replaces dozens of individual indicator calls
 *   • Guarantees identical calculations everywhere
 *   • Easy to add new indicators later
 */
export function computeIndicators(
    primary: OhlcvData,
    htf?: OhlcvData
): IndicatorMap {
    // Safety check – prevent crashes if data is missing
    if (primary.length === 0) {
        throw new Error('Primary OHLCV data is empty – cannot compute indicators');
    }

    // Extract arrays for cleaner code
    const pCloses = primary.closes;
    const pOpens = primary.opens;
    const pHighs = primary.highs;
    const pLows = primary.lows;
    const pVolumes = primary.volumes;

    // =========================================================================
    // PRIMARY TIMEFRAME INDICATORS (fast signals)
    // =========================================================================

    // Moving averages – trend direction
    const emaShort = calculateEMA(pCloses, 20);      // Fast EMA for short-term trend
    const emaMid = calculateEMA(pCloses, 50);        // Medium-term trend
    const emaLong = calculateEMA(pCloses, 200);      // Long-term support/resistance
    const sma = calculateSMA(pCloses, 20);           // Bollinger Band middle line

    // Volume-weighted averages – respect trading activity
    const vwma = calculateVWMA(pCloses, pVolumes, 20);
    const vwap = calculateVWAP(pHighs, pLows, pCloses, pVolumes);

    // Oscillators – overbought/oversold detection
    const rsi = calculateRSI(pCloses, 14);
    const macdResult = calculateMACD(pCloses, 12, 26, 9);
    const macdLine = macdResult.map(m => m.MACD);
    const macdSignal = macdResult.map(m => m.signal);
    const macdHistogram = macdResult.map(m => m.histogram);
    const stochastic = calculateStochastic(pHighs, pLows, pCloses, 14, 3);

    // Volatility & risk management
    const atr = calculateATR(pHighs, pLows, pCloses, 14);
    const bb = calculateBollingerBands(pCloses, 20, 2);

    // Volume confirmation & momentum
    const obv = calculateOBV(pCloses, pVolumes);
    const momentum = calculateMomentum(pCloses, 10);

    // Price action patterns
    const engulfing = detectEngulfing(pOpens, pHighs, pLows, pCloses);

    // Bollinger Band derived metrics
    const bandwidth = bb.map((b, _i) => {
        const mid = b.middle;
        // Avoid division by zero in flat markets
        return mid === 0 ? 0 : ((b.upper - b.lower) / mid) * 100;
    });

    const percentB = bb.map((b, i) => {
        const range = b.upper - b.lower;
        if (range === 0) return 0.5; // Neutral position
        return (pCloses[i] - b.lower) / range; // 0 = at lower band, 1 = at upper
    });

    // =========================================================================
    // HIGHER TIMEFRAME (HTF) INDICATORS – Trend filter & regime detection
    // =========================================================================

    // Default empty arrays if no HTF data
    let htfEmaMid: number[] = [];
    let htfRsi: number[] = [];
    let htfAdx: { adx: number[]; pdi: number[]; mdi: number[] } = { adx: [], pdi: [], mdi: [] };

    // Only compute HTF indicators if sufficient data is available
    if (htf && htf.closes.length >= 50) {
        htfEmaMid = calculateEMA(htf.closes, 50);                    // Main HTF trend filter
        htfRsi = calculateRSI(htf.closes, 14);                       // Longer-term momentum
        const adxResult = calculateADX(htf.highs, htf.lows, htf.closes, 14);
        htfAdx = {
            adx: adxResult.map(a => a.adx ?? 0),
            pdi: adxResult.map(a => a.pdi ?? 0),
            mdi: adxResult.map(a => a.mdi ?? 0),
        };
    }

    // =========================================================================
    // LATEST VALUES – Most code only needs these for real-time decisions
    // =========================================================================

    const lastIdx = pCloses.length - 1;
    const lastHtfIdx = htf?.closes.length ? htf.closes.length - 1 : -1;

    const last = {
        // Primary timeframe
        close: pCloses[lastIdx] ?? 0,
        rsi: rsi.at(-1) ?? 50,
        emaShort: emaShort.at(-1) ?? 0,
        emaMid: emaMid.at(-1) ?? 0,
        emaLong: emaLong.at(-1) ?? 0,
        atr: atr.at(-1) ?? 0,
        macdLine: macdLine.at(-1) ?? 0,
        macdSignal: macdSignal.at(-1) ?? 0,
        macdHistogram: macdHistogram.at(-1) ?? 0,
        bbUpper: bb.at(-1)?.upper ?? 0,
        bbMiddle: bb.at(-1)?.middle ?? 0,
        bbLower: bb.at(-1)?.lower ?? 0,
        bbBandwidth: bandwidth.at(-1) ?? 0,
        percentB: percentB.at(-1) ?? 0,
        stochasticK: stochastic.at(-1)?.k ?? 50,
        stochasticD: stochastic.at(-1)?.d ?? 50,
        momentum: momentum.at(-1) ?? 0,
        engulfing: engulfing.at(-1) ?? null,
        vwap: vwap.at(-1) ?? 0,
        vwma: vwma.at(-1) ?? 0,
        obv: obv.at(-1) ?? 0,

        // HTF latest values – crucial for trend confirmation
        htfEmaMid: lastHtfIdx >= 0 ? htfEmaMid.at(-1) ?? 0 : 0,
        htfRsi: lastHtfIdx >= 0 ? htfRsi.at(-1) ?? 50 : 50,
        htfAdx: lastHtfIdx >= 0 ? htfAdx.adx.at(-1) ?? 0 : 0,
        htfPdi: lastHtfIdx >= 0 ? htfAdx.pdi.at(-1) ?? 0 : 0,
        htfMdi: lastHtfIdx >= 0 ? htfAdx.mdi.at(-1) ?? 0 : 0,
    };

    // =========================================================================
    // RETURN COMPLETE INDICATOR MAP
    // =========================================================================
    return {
        // Raw data
        close: pCloses,
        high: pHighs,
        low: pLows,
        open: pOpens,
        volume: pVolumes,

        // Primary timeframe indicators
        sma,
        emaShort,
        emaMid,
        emaLong,
        vwma,
        vwap,

        rsi,
        momentum,
        stochastic: { k: stochastic.map(s => s.k), d: stochastic.map(s => s.d) },
        macd: { line: macdLine.map(Number), signal: macdSignal.map(Number), histogram: macdHistogram.map(Number) },

        atr,
        bollingerBands: {
            upper: bb.map(b => b.upper),
            middle: bb.map(b => b.middle),
            lower: bb.map(b => b.lower),
            bandwidth,
            percentB,
        },

        obv,
        engulfing,

        // HTF indicators
        htfEmaMid,
        htfRsi,
        htfAdx,

        // Latest values for quick access
        last,
    };
}
