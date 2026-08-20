// src/lib/strategy/regime/types.ts

/**
 * High-level classification of the current market environment.
 *
 * This is instrumentation only in the current phase. Regime classification
 * must not influence scoring, signal generation, confidence, risk parameters,
 * or trade eligibility.
 */
export type MarketRegime =
    | 'strong_trend'
    | 'weak_trend'
    | 'ranging'
    | 'high_volatility'
    | 'choppy';

/**
 * Raw market inputs and final classification captured at signal time.
 *
 * The raw values are intentionally retained so historical classifications can
 * be audited and thresholds can be tuned later using collected simulation data.
 */
export interface RegimeClassification {
    /** Final assigned market regime. */
    regime: MarketRegime;

    /** Higher-timeframe ADX used for trend-strength classification. */
    adx: number;

    /** Bollinger Band width as a percentage of the middle band. */
    bbBandwidth: number;

    /** ATR expressed as a percentage of the current price. */
    atrPct: number;

    /** Existing directional bias from trend and volume analysis. */
    trendBias: 'bullish' | 'bearish' | 'neutral';

    /**
     * Raw positive directional indicator used to calculate DI separation.
     */
    pdi: number;

    /**
     * Raw negative directional indicator used to calculate DI separation.
     */
    mdi: number;

    /**
     * Absolute directional movement separation: |pdi - mdi|.
     */
    diDiff: number;

    /**
     * Regime's own ADX+DI trending determination — computed independently
     * inside classifyRegime.ts, decoupled from the trade-eligibility gate
     * in trendVolumeAnalysis.ts (which uses DI-separation only, no ADX
     * floor). This keeps regime labels internally consistent even as gate
     * logic evolves.
     */
    isTrending: boolean;
}
