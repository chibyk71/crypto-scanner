// src/lib/strategy/regime/classifyRegime.ts
// Phase 2 — Regime Engine (shadow mode)
//
// Public regimes: TREND | RANGE | BREAKOUT
// Precedence: BREAKOUT → TREND → RANGE
//
// Causality: only candidate-candle and prior history available at signal time.
// No future candles, future highs/lows, or future indicator values.
//
// Shadow mode: result must NOT influence scoring, signal selection,
// confidence, ML, risk, sizing, or trade eligibility.

import type { IndicatorMap } from '../../utils/indicatorUtils';
import { detectBbSqueezeBreakout } from '../patterns/bbSqueezeBreakout';
import {
    MIN_ADX,
    MIN_DI_DIFF,
    RELATIVE_VOLUME_MULTIPLIER,
} from '../constants';
import type { TrendAndVolume } from '../types';
import type {
    BreakoutDirection,
    MarketRegime,
    RegimeCandleContext,
    RegimeClassification,
} from './types';

/**
 * Max relative |price − VWAP| / VWAP for near-VWAP RANGE context.
 * Defined here (not in shared scoring constants) so Phase 2 cannot
 * accidentally alter score thresholds.
 */
export const REGIME_NEAR_VWAP_PCT = 0.01; // 1%

/** Finite-number guard — NaN/Infinity treated as missing (0 / false). */
function finite(n: number, fallback = 0): number {
    return Number.isFinite(n) ? n : fallback;
}

/**
 * Volume confirmation for BREAKOUT.
 *
 * Uses relative volume vs the prior window average (excludes current candle
 * from the baseline). Falls back to hasVolumeSurge when provided by
 * trend/volume analysis. Requires a finite positive baseline.
 */
export function hasBreakoutVolumeConfirmation(
    volumes: number[] | undefined,
    hasVolumeSurge?: boolean
): boolean {
    if (hasVolumeSurge === true) {
        return true;
    }
    if (!volumes || volumes.length < 5) {
        return false;
    }
    const current = finite(volumes[volumes.length - 1], NaN);
    if (!Number.isFinite(current) || current <= 0) {
        return false;
    }
    const prior = volumes.slice(-21, -1).map((v) => finite(v, 0));
    const usable = prior.filter((v) => v > 0);
    if (usable.length < 3) {
        return false;
    }
    const avg = usable.reduce((a, b) => a + b, 0) / usable.length;
    if (!(avg > 0) || !Number.isFinite(avg)) {
        return false;
    }
    return current >= avg * RELATIVE_VOLUME_MULTIPLIER;
}

/**
 * EMA structural alignment from centralized indicator last-values.
 * Bullish: short ≥ mid ≥ long. Bearish: short ≤ mid ≤ long.
 */
function emaAlignment(indicators: IndicatorMap): {
    emaAlignedBullish: boolean;
    emaAlignedBearish: boolean;
    emaNeutral: boolean;
} {
    const short = finite(indicators.last.emaShort);
    const mid = finite(indicators.last.emaMid);
    const long = finite(indicators.last.emaLong);
    const emaAlignedBullish = short >= mid && mid >= long && short > long;
    const emaAlignedBearish = short <= mid && mid <= long && short < long;
    return {
        emaAlignedBullish,
        emaAlignedBearish,
        emaNeutral: !emaAlignedBullish && !emaAlignedBearish,
    };
}

/**
 * TREND evidence: persistent directional movement.
 *
 * Explicit boolean conditions (not a point score):
 *   - ADX above MIN_ADX (directional strength)
 *   - DI separation above MIN_DI_DIFF
 *   - EMA structural alignment in one direction
 */
function evaluateTrendEvidence(
    adx: number,
    diDiff: number,
    emaAlignedBullish: boolean,
    emaAlignedBearish: boolean
): boolean {
    const strength = adx > MIN_ADX && diDiff > MIN_DI_DIFF;
    const structure = emaAlignedBullish || emaAlignedBearish;
    return strength && structure;
}

/**
 * Explicit RANGE evidence (boolean structure, not a residual-only bucket).
 *
 * After BREAKOUT is ruled out, RANGE evidence requires:
 *   - weak/insufficient ADX and/or insufficient DI separation
 *   - lack of meaningful EMA directional alignment (emaNeutral)
 *
 * nearVwap is supporting context (exposed on the result) and is not required
 * alone to claim RANGE evidence, but is typical of range conditions.
 */
function evaluateRangeEvidence(
    adx: number,
    diDiff: number,
    emaNeutral: boolean,
    nearVwap: boolean
): {
    weakAdx: boolean;
    weakDiSeparation: boolean;
    isRangeEvidence: boolean;
} {
    const weakAdx = adx <= MIN_ADX;
    const weakDiSeparation = diDiff <= MIN_DI_DIFF;
    const weakDirectionalStrength = weakAdx || weakDiSeparation;
    // Explicit range: non-persistent direction AND no EMA trend stack.
    // nearVwap reinforces but is not the sole gate (markets can range off VWAP).
    const isRangeEvidence = weakDirectionalStrength && emaNeutral;
    void nearVwap; // supporting diagnostic; kept as parameter for call-site clarity
    return { weakAdx, weakDiSeparation, isRangeEvidence };
}

/**
 * Classifies the candidate-candle market regime.
 *
 * @param indicators - Precomputed IndicatorMap (causal at signal time)
 * @param price - Current candidate price (for ATR % and near-VWAP)
 * @param trendBias - From analyzeTrendAndVolume (diagnostic context)
 * @param candle - Optional closes/volumes for BREAKOUT structure + volume
 */
export function classifyRegime(
    indicators: IndicatorMap,
    price: number,
    trendBias: TrendAndVolume['trendBias'],
    candle?: RegimeCandleContext
): RegimeClassification {
    const adx = finite(indicators.last.htfAdx);
    const pdi = finite(indicators.last.htfPdi);
    const mdi = finite(indicators.last.htfMdi);
    const diDiff = Math.abs(pdi - mdi);

    const atrPct =
        price > 0 ? (finite(indicators.last.atr) / price) * 100 : 0;
    const bbBandwidth = finite(indicators.last.bbBandwidth);

    const { emaAlignedBullish, emaAlignedBearish, emaNeutral } =
        emaAlignment(indicators);
    const vwap = finite(indicators.last.vwap);
    const vwma = finite(indicators.last.vwma);
    const vwmaAboveVwap = vwma > vwap && vwap > 0;
    const nearVwap =
        vwap > 0 &&
        Number.isFinite(price) &&
        Math.abs(price - vwap) / vwap <= REGIME_NEAR_VWAP_PCT;

    const isTrendEvidence = evaluateTrendEvidence(
        adx,
        diDiff,
        emaAlignedBullish,
        emaAlignedBearish
    );

    const { weakAdx, weakDiSeparation, isRangeEvidence } =
        evaluateRangeEvidence(adx, diDiff, emaNeutral, nearVwap);

    // ---- BREAKOUT structure (reuse existing causal detector) ----
    // detectBbSqueezeBreakout requires compression + expansion + directional
    // break of the prior candle's bands. High ATR alone is NOT sufficient.
    let breakoutDirection: BreakoutDirection = null;
    let breakoutStructure = false;
    if (candle?.closes && candle.closes.length >= 2) {
        const dir = detectBbSqueezeBreakout(indicators, candle.closes);
        if (dir === 'bullish' || dir === 'bearish') {
            breakoutDirection = dir;
            breakoutStructure = true;
        }
    }

    const volumeConfirmed = hasBreakoutVolumeConfirmation(
        candle?.volumes,
        candle?.hasVolumeSurge
    );
    const isBreakout = breakoutStructure && volumeConfirmed;

    // ---- Precedence: BREAKOUT → TREND → RANGE ----
    // RANGE is assigned when BREAKOUT and TREND do not hold. Explicit
    // isRangeEvidence documents *why* RANGE is appropriate; when the
    // residual falls to RANGE without full evidence, isRangeEvidence is
    // false so audits can distinguish true range from unexplained residual.
    let regime: MarketRegime;
    if (isBreakout) {
        regime = 'BREAKOUT';
    } else if (isTrendEvidence) {
        regime = 'TREND';
    } else {
        regime = 'RANGE';
    }

    return {
        regime,
        adx,
        pdi,
        mdi,
        diDiff,
        emaAlignedBullish,
        emaAlignedBearish,
        emaNeutral,
        vwmaAboveVwap,
        nearVwap,
        trendBias,
        isTrendEvidence,
        weakAdx,
        weakDiSeparation,
        isRangeEvidence,
        atrPct,
        bbBandwidth,
        breakoutStructure,
        breakoutDirection,
        volumeConfirmed,
        isBreakout,
    };
}
