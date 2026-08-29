// Regime → setup router. One subsystem per public regime.

import type { MarketRegime, RegimeClassification } from '../../../regime/types';
import type { SetupResult } from '../../types';
import { detectBreakoutSetup } from './breakoutSetup';
import { detectRangeSetup } from './rangeSetup';
import { detectTrendSetup } from './trendSetup';

/**
 * Route classification to the matching setup detector.
 * Does not use legacy scores.
 */
export function detectSetupForRegime(
    classification: RegimeClassification
): SetupResult {
    const regime: MarketRegime = classification.regime;
    switch (regime) {
        case 'TREND':
            return detectTrendSetup(classification);
        case 'RANGE':
            return detectRangeSetup(classification);
        case 'BREAKOUT':
            return detectBreakoutSetup(classification);
        default: {
            // Exhaustiveness guard
            const _exhaustive: never = regime;
            return {
                detected: false,
                setupId: null,
                side: null,
                reasons: [`unknown regime: ${String(_exhaustive)}`],
                diagnostics: {},
            };
        }
    }
}
