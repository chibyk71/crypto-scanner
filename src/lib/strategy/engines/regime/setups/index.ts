// Regime → setup router. One subsystem per public regime.
// Each detector receives full SetupContext (classification + indicators + price)
// so setup qualification and entry triggers can use causal candle data.

import type { MarketRegime } from '../../../regime/types';
import type { SetupContext, SetupResult } from '../../types';
import { emptySetupResult } from '../../types';

import { detectBreakoutSetup } from './breakoutSetup';
import { detectRangeSetup } from './rangeSetup';
import { detectTrendSetup } from './trendSetup';

/**
 * Route classification to the matching setup + entry-trigger detector.
 * Does not use legacy scores.
 */
export function detectSetupForRegime(ctx: SetupContext): SetupResult {
    const regime: MarketRegime = ctx.classification.regime;
    switch (regime) {
        case 'TREND':
            return detectTrendSetup(ctx);
        case 'RANGE':
            return detectRangeSetup(ctx);
        case 'BREAKOUT':
            return detectBreakoutSetup(ctx);
        default: {
            const _exhaustive: never = regime;
            return emptySetupResult({
                reasons: [`unknown regime: ${String(_exhaustive)}`],
            });
        }
    }
}
