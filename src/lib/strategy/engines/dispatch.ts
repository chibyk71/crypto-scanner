// src/lib/strategy/engines/dispatch.ts
// Single engine-selection boundary.
//
// default = legacy (existing Strategy.generateSignal)
// regime  = experimental runRegimeEngine
//
// Does not embed if (regimeMode) inside scoring.

import type { TradeSignal } from '../../../types';
import type { StrategyInput } from '../types';
import { runRegimeEngine } from './regime/engine';
import type { StrategyEngineId } from './types';

/**
 * Minimal legacy-strategy surface used by the dispatcher.
 * Avoids circular imports with Strategy class module graph.
 */
export interface LegacyStrategyLike {
    generateSignal(input: StrategyInput): Promise<TradeSignal>;
}

/**
 * Dispatch a candidate to the selected strategy engine.
 *
 * Legacy path is a pure passthrough to Strategy.generateSignal — behavior
 * unchanged. Regime path never enters scoring.
 */
export async function dispatchStrategyEngine(
    engine: StrategyEngineId,
    legacyStrategy: LegacyStrategyLike,
    input: StrategyInput
): Promise<TradeSignal> {
    if (engine === 'regime') {
        return runRegimeEngine(input).signal;
    }
    return legacyStrategy.generateSignal(input);
}
