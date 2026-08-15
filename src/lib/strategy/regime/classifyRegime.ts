// src/lib/strategy/regime/classifyRegime.ts

import type { IndicatorMap } from '../../utils/indicatorUtils';
import {
    MAX_ATR_PCT,
    MIN_ADX,
    MIN_BB_BANDWIDTH_PCT,
    MIN_DI_DIFF,
} from '../constants';
import type { TrendAndVolume } from '../types';
import type { RegimeClassification } from './types';

/**
 * Classifies the current market regime using indicators that have already been
 * computed by the strategy pipeline.
 *
 * This is a read-only instrumentation function. Its result must not influence
 * scoring, signal selection, confidence, risk parameters, or trade eligibility.
 *
 * Classification precedence:
 *
 * 1. high_volatility
 * 2. strong_trend
 * 3. weak_trend
 * 4. ranging
 * 5. choppy
 */
export function classifyRegime(
    indicators: IndicatorMap,
    price: number,
    trendBias: TrendAndVolume['trendBias'],
    isTrending: boolean
): RegimeClassification {
    const adx = indicators.last.htfAdx;
    const pdi = indicators.last.htfPdi;
    const mdi = indicators.last.htfMdi;

    const diDiff = Math.abs(pdi - mdi);

    const atrPct = price > 0
        ? (indicators.last.atr / price) * 100
        : 0;


    const bbBandwidth = indicators.last.bbBandwidth;

    let regime: RegimeClassification['regime'];

    // High volatility takes precedence over trend classification.
    if (atrPct > MAX_ATR_PCT * 0.7) {
        regime = 'high_volatility';
    } else if (adx > 35 && diDiff > MIN_DI_DIFF) {
        regime = 'strong_trend';
    } else if (
        adx > MIN_ADX &&
        adx <= 35 &&
        diDiff > MIN_DI_DIFF
    ) {
        regime = 'weak_trend';
    } else if (
        !isTrending &&
        bbBandwidth >= MIN_BB_BANDWIDTH_PCT
    ) {
        regime = 'ranging';
    } else {
        // Any non-trending market with bandwidth below the existing
        // flat-market threshold is classified as choppy.
        //
        // Classification boundary note:
        // A market that fails the ADX/DI trend checks while `isTrending`
        // remains true under the existing strategy logic will also fall
        // through to this branch. This is intentional for now rather than
        // inventing another threshold; collected data can determine whether
        // this edge case needs its own rule later.
        regime = 'choppy';
    }

    return {
        regime,
        adx,
        bbBandwidth,
        atrPct,
        trendBias,
        pdi,
        mdi,
        diDiff,
        isTrending,
    };
}
