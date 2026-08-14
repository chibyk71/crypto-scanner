// src/lib/strategy/market/trendVolumeAnalysis.ts
// =============================================================================
// TREND + VOLUME ANALYSIS
//
// This module is a mechanical extraction from src/lib/strategy.ts.
//
// It contains:
//   1. The neutral TrendAndVolume helper previously implemented as
//      Strategy._neutral().
//   2. The market analysis previously implemented as
//      Strategy._analyzeTrendAndVolume().
//
// IMPORTANT:
// This refactor intentionally preserves the original calculations,
// conditions, thresholds, execution order, and log messages.
//
// The only structural change is that the previous class methods are now
// standalone functions. Since neither method depends on Strategy instance
// state, this does not require passing `this` or introducing shared state.
// =============================================================================

import type { OhlcvData } from '../../../types';
import { ExchangeService } from '../../services/exchange';
import { createLogger } from '../../logger';
import { config } from '../../config/settings';
import type { IndicatorMap } from '../../utils/indicatorUtils';
import {
    detectEngulfing,
    detectLiquiditySweep,
} from '../../indicators';

import {
    BULL_MARKET_LIQUIDITY_MULTIPLIER,
    LIQUIDITY_SWEEP_LOOKBACK,
    MIN_ADX,
    MIN_AVG_VOLUME_USD_PER_HOUR,
    MIN_DI_DIFF,
    RELATIVE_VOLUME_MULTIPLIER,
    VOLUME_SURGE_MULTIPLIER,
} from '../constants';

import type { TrendAndVolume } from '../types';

// Dedicated logger – all strategy-related messages tagged 'Strategy'
//
// This is kept identical to the original strategy module so log output
// continues to use the same logger category.
const logger = createLogger('Strategy');

// =============================================================================
// HELPER: Neutral regime state (DRY early exit)
// =============================================================================

/**
 * Returns a neutral TrendAndVolume object.
 *
 * Used for:
 *   • Early exits (insufficient data, low liquidity)
 *   • Prevents downstream null checks
 *
 * Previously:
 *   private _neutral(): TrendAndVolume
 *
 * It is exported because analyzeTrendAndVolume() is now a standalone function
 * rather than a method on Strategy.
 */
export function neutral(): TrendAndVolume {
    return {
        hasVolumeSurge: false,
        vwmaFalling: false,
        trendBias: 'neutral',
        isTrending: false,
        engulfing: [null],
        liquiditySweep: [null],
    };
}

// =============================================================================
// TREND + VOLUME ANALYSIS: Market regime detection with liquidity filter
// =============================================================================

/**
 * Analyzes higher-timeframe trend strength, volume behavior, and liquidity.
 *
 * Called from:
 *   • generateSignal() – early in the pipeline
 *
 * Responsibilities:
 *   • Determine HTF trend bias (bullish/bearish/neutral) using ADX + DI
 *   • Calculate average hourly volume in USD for liquidity filtering
 *   • Detect volume surges (both USD and base volume)
 *   • Identify VWMA slope direction
 *   • Detect engulfing patterns (cheap operation)
 *   • Early exit with neutral result if liquidity too low
 *
 * Why liquidity check here?
 *   • Prevents processing illiquid symbols (slippage, fake moves)
 *   • Dynamic threshold: relaxed in strong bull trends (ADX > 35)
 *
 * @param primaryData - Fast timeframe OHLCV (for volume calculations)
 * @param indicators - Pre-computed indicators (for HTF ADX/DI)
 * @param _price - Current price (unused but kept for future extensions)
 * @returns TrendAndVolume summary used throughout scoring
 */
export function analyzeTrendAndVolume(
    primaryData: OhlcvData,
    indicators: IndicatorMap,
    _price: number
): TrendAndVolume {
    // ------------------------------------------------------------------
    // 1. HTF TREND INITIALIZATION & LIQUIDITY CHECK
    // ------------------------------------------------------------------

    const LOOKBACK = 50;

    const volSlice = primaryData.volumes.slice(-LOOKBACK);
    const priceSlice = primaryData.closes.slice(-LOOKBACK);

    // Safety check for insufficient data
    const len = Math.min(volSlice.length, priceSlice.length);

    if (len === 0) {
        logger.warn(`No data for ${primaryData.symbol} – skipping`);

        return neutral();
    }

    // Calculate average volume in USD, scaled to a true per-hour rate.
    // avgBaseVol/avgPrice below are per-CANDLE — candle duration depends on
    // config.scanner.primaryTimeframe, so we can't compare that directly
    // against MIN_AVG_VOLUME_USD_PER_HOUR without scaling it up.
    const avgBaseVol =
        volSlice.slice(0, len).reduce((a, b) => a + b, 0) / len;

    const avgPrice =
        priceSlice.slice(0, len).reduce((a, b) => a + b, 0) / len;

    const avgVolumePerCandleUSD =
        avgBaseVol * avgPrice;

    const candleDurationMs =
        ExchangeService.toTimeframeMs(config.scanner.primaryTimeframe);

    const candlesPerHour =
        (60 * 60 * 1000) / candleDurationMs;

    const avgVolumeUSD =
        avgVolumePerCandleUSD * candlesPerHour;

    // Determine HTF trend bias using ADX and Directional Indicators
    const {
        htfAdx: adx,
        htfPdi: pdi,
        htfMdi: mdi,
    } = indicators.last;

    const diDiff = Math.abs(pdi - mdi);

    // Debug log – helpful for tuning ADX thresholds
    console.log(
        `ADX Analysis for ${primaryData.symbol}: ADX=${adx.toFixed(2)}, +DI=${pdi.toFixed(2)}, -DI=${mdi.toFixed(2)}, DI Diff=${diDiff.toFixed(2)}`
    );

    const isTrending =
        adx > MIN_ADX &&
        diDiff > MIN_DI_DIFF;

    const trendBias = isTrending
        ? pdi > mdi
            ? 'bullish'
            : 'bearish'
        : 'neutral';

    // Dynamic liquidity threshold: more lenient in strong bull trends
    const baseThreshold =
        MIN_AVG_VOLUME_USD_PER_HOUR;

    const bullMultiplier =
        trendBias === 'bullish' && adx > 35
            ? BULL_MARKET_LIQUIDITY_MULTIPLIER
            : 1.0;

    const threshold =
        baseThreshold * bullMultiplier;

    const hasLiquidity =
        avgVolumeUSD >= threshold;

    // ------------------------------------------------------------------
    // 2. ENGULFING PATTERN DETECTION (always run – low cost)
    // ------------------------------------------------------------------

    const engulfing = detectEngulfing(
        primaryData.opens,
        primaryData.highs,
        primaryData.lows,
        primaryData.closes
    );

    // ------------------------------------------------------------------
    // 2b. LIQUIDITY SWEEP DETECTION (always run – low cost)
    // ------------------------------------------------------------------

    const liquiditySweep = detectLiquiditySweep(
        primaryData.highs,
        primaryData.lows,
        primaryData.closes,
        LIQUIDITY_SWEEP_LOOKBACK
    );

    // EARLY EXIT: Reject low-liquidity symbols entirely
    if (!hasLiquidity) {
        logger.info(
            `Low liquidity ${primaryData.symbol}: ` +
            `$${avgVolumeUSD.toFixed(0)}/hr < $${threshold.toFixed(0)} ` +
            `(trend=${trendBias})`
        );

        return neutral();
    }

    // ------------------------------------------------------------------
    // 3. VOLUME SURGE DETECTION – Dual confirmation (USD + base volume)
    // ------------------------------------------------------------------

    const lookback = 20; // Use obvLookback for short-term volume average

    const recentVols =
        primaryData.volumes.slice(-lookback - 1, -1);

    const recentPrices =
        primaryData.closes.slice(-lookback - 1, -1);

    // Average volume in USD over previous 20 candles
    const avgPrevUSD =
        recentVols.reduce(
            (sum, v, i) => sum + v * recentPrices[i],
            0
        ) / lookback;

    // Current candle volume in USD
    const currentVolUSD =
        primaryData.volumes[primaryData.volumes.length - 1] *
        primaryData.closes[primaryData.closes.length - 1];

    // Primary surge check (USD value)
    let hasVolumeSurge =
        currentVolUSD >
        avgPrevUSD * VOLUME_SURGE_MULTIPLIER;

    // Secondary check: raw base volume surge (prevents price-driven false positives)
    const volLookback = 20;

    const recentBaseVols =
        primaryData.volumes.slice(-volLookback - 1, -1);

    const avgBaseVol20 =
        recentBaseVols.reduce((sum, v) => sum + v, 0) /
        volLookback;

    const currentBaseVol =
        primaryData.volumes[primaryData.volumes.length - 1];

    const hasRelativeVolumeSurge =
        currentBaseVol >
        avgBaseVol20 * RELATIVE_VOLUME_MULTIPLIER;

    // Require both for strong confirmation
    hasVolumeSurge =
        hasVolumeSurge &&
        hasRelativeVolumeSurge;

    // ------------------------------------------------------------------
    // 4. VWMA SLOPE DIRECTION
    // ------------------------------------------------------------------

    const vwmaSlope =
        indicators.last.vwma -
        (
            indicators.vwma[indicators.vwma.length - 2] ??
            indicators.last.vwma
        );

    const vwmaFalling =
        vwmaSlope < 0;

    // ------------------------------------------------------------------
    // 5. RETURN COMPREHENSIVE REGIME SUMMARY
    // ------------------------------------------------------------------

    return {
        hasVolumeSurge,
        vwmaFalling,
        trendBias,
        isTrending,
        engulfing,
        liquiditySweep,
    };
}
