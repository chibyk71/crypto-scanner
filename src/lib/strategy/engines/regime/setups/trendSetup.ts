// TREND setup detector — minimal pipeline proof (not a full entry system).
// Uses Phase 2 regime diagnostics + existing trendBias only.
// Does NOT call scoring / computeScores.

import type { RegimeClassification } from '../../../regime/types';
import type { SetupResult } from '../../types';

/**
 * Minimal TREND continuation hypothesis:
 *   regime TREND + matching bias + matching EMA alignment → side.
 * No additive indicator score.
 */
export function detectTrendSetup(
    classification: RegimeClassification
): SetupResult {
    const reasons: string[] = [];
    const diagnostics: SetupResult['diagnostics'] = {
        isTrendEvidence: classification.isTrendEvidence,
        emaAlignedBullish: classification.emaAlignedBullish,
        emaAlignedBearish: classification.emaAlignedBearish,
        trendBias: classification.trendBias,
        adx: classification.adx,
        diDiff: classification.diDiff,
    };

    if (classification.regime !== 'TREND') {
        reasons.push('trend setup: regime is not TREND');
        return {
            detected: false,
            setupId: null,
            side: null,
            reasons,
            diagnostics,
        };
    }

    if (!classification.isTrendEvidence) {
        reasons.push('trend setup: isTrendEvidence is false');
        return {
            detected: false,
            setupId: null,
            side: null,
            reasons,
            diagnostics,
        };
    }

    if (
        classification.trendBias === 'bullish' &&
        classification.emaAlignedBullish
    ) {
        reasons.push(
            'trend setup: TREND + bullish bias + bullish EMA stack'
        );
        return {
            detected: true,
            setupId: 'trend_continuation_long',
            side: 'buy',
            reasons,
            diagnostics,
        };
    }

    if (
        classification.trendBias === 'bearish' &&
        classification.emaAlignedBearish
    ) {
        reasons.push(
            'trend setup: TREND + bearish bias + bearish EMA stack'
        );
        return {
            detected: true,
            setupId: 'trend_continuation_short',
            side: 'sell',
            reasons,
            diagnostics,
        };
    }

    reasons.push(
        'trend setup: bias/EMA alignment do not form a continuation hypothesis'
    );
    return {
        detected: false,
        setupId: null,
        side: null,
        reasons,
        diagnostics,
    };
}
