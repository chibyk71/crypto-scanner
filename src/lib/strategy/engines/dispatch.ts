// src/lib/strategy/engines/dispatch.ts
// Single engine-selection boundary.
//
// default = legacy (existing Strategy.generateSignal)
// regime  = experimental runRegimeEngine
//
// Does not embed if (regimeMode) inside scoring.

import type { TradeSignal } from '../../../types';
import type { MLService } from '../../services/mlService';
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
 *
 * mlService is required for the regime path so extractFeatures can populate
 * signal.features (needed by simulateTrade). It is not used for ML predict
 * on the regime decision path (intentional for first live run).
 */
export async function dispatchStrategyEngine(
    engine: StrategyEngineId,
    legacyStrategy: LegacyStrategyLike,
    input: StrategyInput,
    mlService: MLService
): Promise<TradeSignal> {
    if (engine === 'regime') {
        return (await runRegimeEngine(input, mlService)).signal;
    }
    return legacyStrategy.generateSignal(input);
}
