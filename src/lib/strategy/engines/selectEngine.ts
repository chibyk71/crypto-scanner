// src/lib/strategy/engines/selectEngine.ts
// Single boundary for strategy-engine selection.

import {
    STRATEGY_ENGINE_IDS,
    type StrategyEngineId,
} from './types';

/**
 * Resolve the active strategy engine from a raw config value.
 *
 * - Default / missing / empty → `legacy` (production-safe)
 * - Explicit `legacy` | `regime` → that engine
 * - Any other value → throws (fail safe; do not silently fall through)
 */
export function resolveStrategyEngine(
    raw: string | null | undefined
): StrategyEngineId {
    const normalized = (raw ?? 'legacy').trim().toLowerCase();
    if (normalized === '' || normalized === 'legacy') {
        return 'legacy';
    }
    if (normalized === 'regime') {
        return 'regime';
    }
    throw new Error(
        `Invalid STRATEGY_ENGINE "${raw}". Expected one of: ${STRATEGY_ENGINE_IDS.join(', ')}`
    );
}

/** True when the experimental regime engine is selected. */
export function isRegimeEngine(id: StrategyEngineId): boolean {
    return id === 'regime';
}
