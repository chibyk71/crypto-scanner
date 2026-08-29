// Deterministic quality filter — architectural boundary only.
// Phase 2B: no ML, no historical threshold optimization.

import type { QualityResult, SetupResult } from '../types';

/**
 * Accept a setup only when it is detected with a concrete side.
 * Rejects are auditable via reasons.
 */
export function applyQualityFilter(setup: SetupResult): QualityResult {
    if (!setup.detected) {
        return {
            accepted: false,
            reasons: [
                'quality: setup not detected',
                ...setup.reasons,
            ],
        };
    }
    if (setup.side !== 'buy' && setup.side !== 'sell') {
        return {
            accepted: false,
            reasons: [
                'quality: setup has no valid side',
                ...setup.reasons,
            ],
        };
    }
    return {
        accepted: true,
        reasons: [
            `quality: accepted setup ${setup.setupId} side=${setup.side}`,
        ],
    };
}
