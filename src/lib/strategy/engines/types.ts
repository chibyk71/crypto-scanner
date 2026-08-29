// src/lib/strategy/engines/types.ts
// Phase 2B — Independent strategy engine selection
//
// legacy = frozen control (existing scoring path)
// regime = experimental treatment (regime → setup → quality → signal)
//
// hybrid is intentionally not implemented in this phase.

/**
 * Selectable strategy engines.
 * Default production behavior is always `legacy`.
 */
export type StrategyEngineId = 'legacy' | 'regime';

export const STRATEGY_ENGINE_IDS: readonly StrategyEngineId[] = [
    'legacy',
    'regime',
] as const;

/** Setup side for experimental engine (null when no setup detected). */
export type SetupSide = 'buy' | 'sell' | null;

/**
 * Structured setup detection result (auditable, not an additive score).
 */
export interface SetupResult {
    /** Whether an explicit setup hypothesis was detected. */
    detected: boolean;
    /** Stable setup identifier (e.g. trend_continuation_long). */
    setupId: string | null;
    /** Intended side, or null when no setup. */
    side: SetupSide;
    /** Human-readable reasons for audit / logging. */
    reasons: string[];
    /** Optional diagnostic key/values (finite scalars or booleans only). */
    diagnostics: Record<string, number | boolean | string | null>;
}

/**
 * Quality-filter decision (architectural boundary; not ML in Phase 2B).
 */
export interface QualityResult {
    accepted: boolean;
    reasons: string[];
}

/**
 * Full experimental-engine evaluation package for data collection.
 * Downstream may attach a subset onto TradeSignal; the rest is loggable.
 */
export interface RegimeEngineEvaluation {
    engine: 'regime';
    regime: import('../regime/types').MarketRegime;
    setup: SetupResult;
    quality: QualityResult;
    signal: import('../../../types').TradeSignal;
}
