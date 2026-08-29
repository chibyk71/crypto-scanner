// src/lib/strategy/regime/types.ts
// Phase 2 — Regime Engine public types
//
// Shadow mode: regime classification is instrumentation only.
// It must not influence scoring, signal generation, confidence,
// risk parameters, or trade eligibility.

/**
 * Public market regime model (exactly three values).
 *
 * Precedence when classifying: BREAKOUT → TREND → RANGE.
 *
 * Historical note: Phase 0/1 DB rows may still contain legacy labels
 * (strong_trend, weak_trend, ranging, high_volatility, choppy). Those are
 * no longer produced by classifyRegime. Baseline metrics treat regime as
 * string | null and remain compatible with historical values.
 */
export type MarketRegime = 'TREND' | 'RANGE' | 'BREAKOUT';

/** Direction implied by a confirmed breakout structure, if any. */
export type BreakoutDirection = 'bullish' | 'bearish' | null;

/**
 * Auditable classification result captured at candidate-candle time.
 *
 * Raw diagnostics answer: why was this candidate classified as TREND /
 * RANGE / BREAKOUT? No full indicator series are stored.
 */
export interface RegimeClassification {
    /** Final public regime label. */
    regime: MarketRegime;

    // ---- directional / trend diagnostics ----
    adx: number;
    pdi: number;
    mdi: number;
    /** |pdi - mdi| */
    diDiff: number;
    /** EMA structural alignment: short vs mid vs long. */
    emaAlignedBullish: boolean;
    emaAlignedBearish: boolean;
    /** True when neither bullish nor bearish EMA stack is present. */
    emaNeutral: boolean;
    /** VWMA relative to VWAP (directional context). */
    vwmaAboveVwap: boolean;
    /** |price - vwap| / vwap within REGIME_NEAR_VWAP_PCT. */
    nearVwap: boolean;
    /** Existing directional bias from trend/volume analysis. */
    trendBias: 'bullish' | 'bearish' | 'neutral';
    /**
     * Classifier-internal TREND evidence (ADX + DI + EMA alignment).
     * Independent of the trade-eligibility gate in trendVolumeAnalysis.
     */
    isTrendEvidence: boolean;

    // ---- range diagnostics (explicit evidence, not an unexplained residual) ----
    /** ADX at or below MIN_ADX — insufficient directional strength. */
    weakAdx: boolean;
    /** DI separation at or below MIN_DI_DIFF. */
    weakDiSeparation: boolean;
    /**
     * Explicit RANGE evidence after BREAKOUT is ruled out:
     * weak directional strength (ADX and/or DI) AND EMA neutrality.
     * nearVwap is supporting context exposed separately.
     */
    isRangeEvidence: boolean;

    // ---- volatility / structure diagnostics ----
    atrPct: number;
    bbBandwidth: number;

    // ---- breakout diagnostics (causal; candidate candle only) ----
    /** True when compression + expansion + directional break all hold. */
    breakoutStructure: boolean;
    breakoutDirection: BreakoutDirection;
    /** Volume confirmation required for BREAKOUT (relative volume and/or surge). */
    volumeConfirmed: boolean;
    /** True only when structure AND volume confirmation both hold. */
    isBreakout: boolean;
}

/**
 * Optional candle context for breakout detection.
 * When omitted, BREAKOUT cannot be assigned (structure requires closes).
 */
export interface RegimeCandleContext {
    /** Primary-timeframe closes (causal series ending at candidate). */
    closes: number[];
    /** Primary-timeframe volumes aligned with closes (for volume confirmation). */
    volumes?: number[];
    /**
     * Optional precomputed surge flag from analyzeTrendAndVolume.
     * When true, counts as volume confirmation without recomputing.
     */
    hasVolumeSurge?: boolean;
}
