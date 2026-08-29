// RANGE setup detector — architectural placeholder.
// Explicit range mean-reversion entry rules are deferred to later evidence-backed phases.
// Does NOT call scoring / computeScores.

import type { RegimeClassification } from '../../../regime/types';
import type { SetupResult } from '../../types';

/**
 * RANGE path for Phase 2B: structure only.
 * Returns detected:false with auditable diagnostics so routing can be tested
 * without inventing unvalidated mean-reversion entry rules.
 */
export function detectRangeSetup(
    classification: RegimeClassification
): SetupResult {
    const reasons: string[] = [];
    const diagnostics: SetupResult['diagnostics'] = {
        isRangeEvidence: classification.isRangeEvidence,
        weakAdx: classification.weakAdx,
        weakDiSeparation: classification.weakDiSeparation,
        emaNeutral: classification.emaNeutral,
        nearVwap: classification.nearVwap,
        adx: classification.adx,
        diDiff: classification.diDiff,
    };

    if (classification.regime !== 'RANGE') {
        reasons.push('range setup: regime is not RANGE');
        return {
            detected: false,
            setupId: null,
            side: null,
            reasons,
            diagnostics,
        };
    }

    reasons.push(
        'range setup: mean-reversion entry not defined in Phase 2B (architecture only)'
    );
    return {
        detected: false,
        setupId: null,
        side: null,
        reasons,
        diagnostics,
    };
}
