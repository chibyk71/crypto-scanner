// src/lib/strategy/patterns/bbSqueezeBreakout.ts
// =============================================================================
// BB SQUEEZE → BREAKOUT DETECTION
//
// This module is a mechanical extraction from src/lib/strategy.ts.
//
// IMPORTANT:
// The detection logic, thresholds, conditions, variable names, and order of
// operations are preserved exactly from the original
// Strategy._detectBbSqueezeBreakout() method.
//
// The only structural change is that this is now a standalone exported
// function instead of a private Strategy class method.
// =============================================================================

import type { IndicatorMap } from '../../utils/indicatorUtils';
import {
    BB_SQUEEZE_EXPANSION_RATIO,
    BB_SQUEEZE_LOOKBACK,
    BB_SQUEEZE_MIN_SQUEEZE_RATIO,
    MIN_BB_BANDWIDTH_PCT,
} from '../constants';

// =============================================================================
// BB SQUEEZE → BREAKOUT DETECTION
// =============================================================================

/**
 * Detects the transition from a low-volatility squeeze to breakout expansion.
 *
 * Logic:
 *   1. Look at the `BB_SQUEEZE_LOOKBACK` candles BEFORE the current one — if at
 *      least BB_SQUEEZE_MIN_SQUEEZE_RATIO of them had bandwidth below
 *      MIN_BB_BANDWIDTH_PCT, the market was "squeezed."
 *   2. Current bandwidth must have expanded by BB_SQUEEZE_EXPANSION_RATIO relative
 *      to the average bandwidth during the squeeze window.
 *   3. Direction is confirmed by current close breaking outside the Bollinger Bands
 *      as they stood on the PREVIOUS candle (i.e. breaking out of the squeeze range,
 *      not just being near band edges from bandwidth calc alone).
 *
 * @param indicators - Centralized indicator results (needs full bandwidth/upper/lower series)
 * @param closes - Primary timeframe close prices
 * @returns 'bullish' | 'bearish' | null
 */
export function detectBbSqueezeBreakout(
    indicators: IndicatorMap,
    closes: number[]
): 'bullish' | 'bearish' | null {
    const bandwidth = indicators.bollingerBands.bandwidth;
    const upper = indicators.bollingerBands.upper;
    const lower = indicators.bollingerBands.lower;

    const n = bandwidth.length;

    // There must be enough historical bandwidth values to:
    //   1. Fill the squeeze lookback window.
    //   2. Have the current candle available after that window.
    // The close series must also be at least as long as the indicator series.
    if (n < BB_SQUEEZE_LOOKBACK + 1 || closes.length < n) {
        return null;
    }

    // `currentIdx` represents the most recent indicator value.
    // `prevIdx` is deliberately used for the directional band comparison below.
    const currentIdx = n - 1;
    const prevIdx = n - 2;

    // Window is the N candles BEFORE the current one (current excluded)
    const windowStart = currentIdx - BB_SQUEEZE_LOOKBACK;
    const window = bandwidth.slice(windowStart, currentIdx);

    // 1. Was it squeezed for most of the window?
    //
    // A candle counts as squeezed only when its bandwidth is strictly below
    // MIN_BB_BANDWIDTH_PCT. The required proportion is controlled by
    // BB_SQUEEZE_MIN_SQUEEZE_RATIO.
    const squeezedCount = window.filter(b => b < MIN_BB_BANDWIDTH_PCT).length;
    const wasSqueezed = squeezedCount / window.length >= BB_SQUEEZE_MIN_SQUEEZE_RATIO;

    if (!wasSqueezed) {
        return null;
    }

    // 2. Is bandwidth now expanding out of that squeeze?
    //
    // Expansion requires BOTH:
    //   • Current bandwidth >= squeeze average × expansion ratio.
    //   • Current bandwidth >= the minimum absolute bandwidth threshold.
    const avgSqueezeBandwidth = window.reduce((a, b) => a + b, 0) / window.length;
    const currentBandwidth = bandwidth[currentIdx];

    const isExpanding =
        currentBandwidth >= avgSqueezeBandwidth * BB_SQUEEZE_EXPANSION_RATIO
        && currentBandwidth >= MIN_BB_BANDWIDTH_PCT;

    if (!isExpanding) {
        return null;
    }

    // 3. Directional confirmation — close breaking outside the PREVIOUS candle's bands
    //    (the bands as they stood while still inside/exiting the squeeze)
    //
    // The previous band's values are intentionally used instead of the current
    // band's values. This preserves the original breakout definition.
    const currentClose = closes[closes.length - 1];
    const prevUpper = upper[prevIdx];
    const prevLower = lower[prevIdx];

    if (currentClose > prevUpper) {
        return 'bullish';
    }

    if (currentClose < prevLower) {
        return 'bearish';
    }

    return null; // expansion confirmed but no clean directional break yet
}
