// src/lib/strategy/engines/types.ts
// Independent strategy engine selection + explicit setup/entry types.
//
// legacy = frozen control (existing scoring path)
// regime = experimental treatment (regime → setup → entry trigger → quality → signal)
//
// hybrid is intentionally not implemented.

import type { IndicatorMap } from '../../utils/indicatorUtils';
import type { RegimeClassification } from '../regime/types';

/**
 * Selectable strategy engines.
 * Default production behavior is always `legacy`.
 */
export type StrategyEngineId = 'legacy' | 'regime';

export const STRATEGY_ENGINE_IDS: readonly StrategyEngineId[] = [
    'legacy',
    'regime',
] as const;

/** Setup side for experimental engine (null when no setup / no entry). */
export type SetupSide = 'buy' | 'sell' | null;

/**
 * Market context available at the decision candle for setup/entry evaluation.
 * All series are closed-candle or current-candle values only (no future data).
 */
export interface SetupContext {
    classification: RegimeClassification;
    indicators: IndicatorMap;
    price: number;
}

/**
 * Structured setup + entry-trigger result (auditable, not an additive score).
 *
 * Distinction:
 *   setupQualified  — market presents the opportunity type this strategy trades
 *   entryTriggered  — specific confirmation required to enter has occurred
 *   invalidation    — condition under which the setup is no longer valid
 *   detected        — true only when qualified AND triggered AND not invalidated
 */
export interface SetupResult {
    /** Fully actionable: qualified + triggered + not invalidated. */
    detected: boolean;
    /** Stable setup identifier (e.g. trend_continuation_long). */
    setupId: string | null;
    /** Intended side, or null when no entry. */
    side: SetupSide;
    /** True when regime/context presents a tradeable setup hypothesis. */
    setupQualified: boolean;
    /** True when the explicit entry confirmation has fired. */
    entryTriggered: boolean;
    /** Human-readable invalidation reason, or null when still valid. */
    invalidation: string | null;
    /** Human-readable reasons for audit / logging. */
    reasons: string[];
    /** Optional diagnostic key/values (finite scalars or booleans only). */
    diagnostics: Record<string, number | boolean | string | null>;
}

/**
 * Quality-filter decision (architectural boundary; not ML).
 */
export interface QualityResult {
    accepted: boolean;
    reasons: string[];
}

/**
 * Full experimental-engine evaluation package for data collection.
 */
export interface RegimeEngineEvaluation {
    engine: 'regime';
    regime: import('../regime/types').MarketRegime;
    setup: SetupResult;
    quality: QualityResult;
    signal: import('../../../types').TradeSignal;
}

/** Empty / rejected setup helper defaults. */
export function emptySetupResult(
    partial: Partial<SetupResult> & { reasons: string[] }
): SetupResult {
    return {
        detected: false,
        setupId: null,
        side: null,
        setupQualified: false,
        entryTriggered: false,
        invalidation: null,
        diagnostics: {},
        ...partial,
    };
}
