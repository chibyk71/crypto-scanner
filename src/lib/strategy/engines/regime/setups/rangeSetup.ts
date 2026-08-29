// RANGE setup — intentionally NO_TRADE in this phase.
//
// A defensible mean-reversion hypothesis requires reliable range boundaries
// (swing high/low or accepted value-area edges) and a rejection trigger at
// those edges. The current indicator set exposes BB/VWAP location but does
// not provide a clean, causal range-boundary model that we are willing to
// treat as an entry specification without evidence-backed design.
//
// Prefer explicit NO_TRADE over manufactured thresholds.
// Not tuned on simulated_trades.csv.

import type { SetupContext, SetupResult } from '../../types';
import { emptySetupResult } from '../../types';

/**
 * RANGE path: explicit no-entry.
 * Regime context is recorded for audit; no side is ever returned.
 */
export function detectRangeSetup(ctx: SetupContext): SetupResult {
    const { classification } = ctx;
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
        return emptySetupResult({ reasons, diagnostics });
    }

    reasons.push(
        'range setup: NO_TRADE — mean-reversion entry deferred (no defensible boundary model yet)'
    );
    return emptySetupResult({
        reasons,
        diagnostics,
        setupQualified: false,
        entryTriggered: false,
        invalidation: null,
    });
}
