// BREAKOUT setup detector — minimal pipeline proof.
// Consumes Phase 2 isBreakout + breakoutDirection only.
// Does NOT call scoring / computeScores.

import type { RegimeClassification } from '../../../regime/types';
import type { SetupResult } from '../../types';

/**
 * Minimal breakout continuation hypothesis:
 *   regime BREAKOUT + confirmed direction → matching side.
 */
export function detectBreakoutSetup(
    classification: RegimeClassification
): SetupResult {
    const reasons: string[] = [];
    const diagnostics: SetupResult['diagnostics'] = {
        isBreakout: classification.isBreakout,
        breakoutStructure: classification.breakoutStructure,
        volumeConfirmed: classification.volumeConfirmed,
        breakoutDirection: classification.breakoutDirection,
    };

    if (classification.regime !== 'BREAKOUT') {
        reasons.push('breakout setup: regime is not BREAKOUT');
        return {
            detected: false,
            setupId: null,
            side: null,
            reasons,
            diagnostics,
        };
    }

    if (!classification.isBreakout) {
        reasons.push('breakout setup: isBreakout is false');
        return {
            detected: false,
            setupId: null,
            side: null,
            reasons,
            diagnostics,
        };
    }

    if (classification.breakoutDirection === 'bullish') {
        reasons.push('breakout setup: bullish structure + volume confirmed');
        return {
            detected: true,
            setupId: 'breakout_long',
            side: 'buy',
            reasons,
            diagnostics,
        };
    }

    if (classification.breakoutDirection === 'bearish') {
        reasons.push('breakout setup: bearish structure + volume confirmed');
        return {
            detected: true,
            setupId: 'breakout_short',
            side: 'sell',
            reasons,
            diagnostics,
        };
    }

    reasons.push('breakout setup: missing breakout direction');
    return {
        detected: false,
        setupId: null,
        side: null,
        reasons,
        diagnostics,
    };
}
