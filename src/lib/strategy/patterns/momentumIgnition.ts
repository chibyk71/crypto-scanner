// src/lib/strategy/patterns/momentumIgnition.ts
// =============================================================================
// MOMENTUM IGNITION
//
// Mechanical extraction from src/lib/strategy.ts.
//
// Contains:
//   • _hasVolumeSurgeAt()
//   • _findRecentIgnitionTrigger()
//
// The original class dependency between the two private methods is replaced
// with a direct function call. No calculation, threshold, condition, or
// execution order has been changed.
// =============================================================================

import type { OhlcvData } from '../../../types';
import {
    MOMENTUM_IGNITION_LOOKBACK,
    RELATIVE_VOLUME_MULTIPLIER,
    VOLUME_SURGE_MULTIPLIER,
} from '../constants';

// =============================================================================
// MOMENTUM IGNITION: Per-candle volume surge check (reusable by index)
// =============================================================================

/**
 * Checks whether a volume surge occurred AT a specific candle index.
 * Mirrors the surge logic in analyzeTrendAndVolume, but parameterized so
 * it can be evaluated at any historical index — needed for the recency gate,
 * which must know whether the surge accompanied the trigger candle itself,
 * not just the most recent candle.
 *
 * @param primaryData - Full OHLCV data
 * @param index - Candle index to check (must have `lookback` candles before it)
 * @returns true if both USD-value and relative base-volume surge conditions are met
 */
export function hasVolumeSurgeAt(
    primaryData: OhlcvData,
    index: number
): boolean {
    const lookback = 20;

    if (index - lookback < 0) {
        return false;
    }

    const recentVols = primaryData.volumes.slice(
        index - lookback,
        index
    );

    const recentPrices = primaryData.closes.slice(
        index - lookback,
        index
    );

    const avgPrevUSD =
        recentVols.reduce(
            (sum, v, i) => sum + v * recentPrices[i],
            0
        ) / lookback;

    const currentVolUSD =
        primaryData.volumes[index] *
        primaryData.closes[index];

    const hasUsdSurge =
        currentVolUSD >
        avgPrevUSD * VOLUME_SURGE_MULTIPLIER;

    const avgBaseVol =
        recentVols.reduce(
            (sum, v) => sum + v,
            0
        ) / lookback;

    const hasRelativeSurge =
        primaryData.volumes[index] >
        avgBaseVol * RELATIVE_VOLUME_MULTIPLIER;

    return hasUsdSurge && hasRelativeSurge;
}

// =============================================================================
// MOMENTUM IGNITION: Recency-gated trigger lookup
// =============================================================================

/**
 * Searches back up to MOMENTUM_IGNITION_LOOKBACK candles for the most recent
 * engulfing pattern that was ALSO confirmed by volume surge at that same candle.
 *
 * Returns the pattern type and how many candles ago it fired (offset), so the
 * caller can apply a decay multiplier — "just ignited" (offset 0) gets full
 * weight, "already moved" (offset 1+) gets progressively less, and anything
 * beyond the lookback window is treated as stale (no bonus at all).
 *
 * @param primaryData - Full OHLCV data
 * @param engulfing - Full engulfing pattern series (aligned with primaryData)
 * @returns { type, offset } of the most recent confirmed trigger, or null if none found
 */
export function findRecentIgnitionTrigger(
    primaryData: OhlcvData,
    engulfing: ('bullish' | 'bearish' | null)[]
): {
    type: 'bullish' | 'bearish';
    offset: number;
} | null {
    const lastIdx = engulfing.length - 1;

    for (
        let offset = 0;
        offset < MOMENTUM_IGNITION_LOOKBACK;
        offset++
    ) {
        const idx = lastIdx - offset;

        if (idx < 0) {
            break;
        }

        const pattern = engulfing[idx];

        if (!pattern) {
            continue;
        }

        if (hasVolumeSurgeAt(primaryData, idx)) {
            return {
                type: pattern,
                offset,
            };
        }
    }

    return null;
}
