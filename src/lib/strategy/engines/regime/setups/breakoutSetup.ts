// BREAKOUT setup + independent entry confirmation.
//
// Hypothesis (not tuned on simulated_trades.csv):
//   Structural squeeze breakout context → confirmation beyond the regime
//   label → entry in breakout direction.
//
// Regime === BREAKOUT is NOT sufficient for entry.
// The classifier already combines structure + volume into isBreakout; the
// entry trigger therefore requires additional causal confirmation that is
// NOT identical to the classifier's sole conditions:
//   • MACD histogram agrees with breakout direction
//   • Decision-candle close remains outside the broken prior band
//
// All conditions use current or previously closed candle data only.

import type { IndicatorMap } from '../../../../utils/indicatorUtils';
import type { SetupContext, SetupResult } from '../../types';
import { emptySetupResult } from '../../types';

function seriesLen(indicators: IndicatorMap): number {
    return Math.min(
        indicators.close.length,
        indicators.bollingerBands.upper.length,
        indicators.bollingerBands.lower.length,
        indicators.bollingerBands.middle.length,
        indicators.macd.histogram.length
    );
}

/**
 * Detect BREAKOUT setup with confirmation trigger independent of the
 * regime label alone.
 */
export function detectBreakoutSetup(ctx: SetupContext): SetupResult {
    const { classification, indicators, price } = ctx;
    const reasons: string[] = [];
    const diagnostics: SetupResult['diagnostics'] = {
        regime: classification.regime,
        breakoutStructure: classification.breakoutStructure,
        breakoutDirection: classification.breakoutDirection,
        volumeConfirmed: classification.volumeConfirmed,
        isBreakout: classification.isBreakout,
        price,
    };

    if (classification.regime !== 'BREAKOUT') {
        reasons.push('breakout setup: regime is not BREAKOUT');
        return emptySetupResult({ reasons, diagnostics });
    }

    // ---- Setup qualification: structural break + direction ----
    // Structure comes from the causal BB squeeze detector (compression +
    // expansion + directional break of prior bands). Direction must be set.
    if (!classification.breakoutStructure) {
        reasons.push('breakout setup: no structural breakout');
        return emptySetupResult({ reasons, diagnostics });
    }

    const dir = classification.breakoutDirection;
    if (dir !== 'bullish' && dir !== 'bearish') {
        reasons.push('breakout setup: missing breakout direction');
        return emptySetupResult({ reasons, diagnostics });
    }

    const side = dir === 'bullish' ? 'buy' : 'sell';
    const setupId = dir === 'bullish' ? 'breakout_long' : 'breakout_short';

    const n = seriesLen(indicators);
    diagnostics.seriesLen = n;

    if (n < 2) {
        reasons.push('breakout setup: insufficient series length for confirmation');
        return emptySetupResult({
            reasons,
            diagnostics,
            setupId,
        });
    }

    const close = indicators.close[n - 1];
    const prevUpper = indicators.bollingerBands.upper[n - 2];
    const prevLower = indicators.bollingerBands.lower[n - 2];
    const mid = indicators.bollingerBands.middle[n - 1];
    const histNow = indicators.macd.histogram[n - 1];
    const histPrev = indicators.macd.histogram[n - 2];

    diagnostics.close = close;
    diagnostics.prevUpper = prevUpper;
    diagnostics.prevLower = prevLower;
    diagnostics.bbMiddle = mid;
    diagnostics.macdHistNow = histNow;
    diagnostics.macdHistPrev = histPrev;

    // ---- Invalidation: failed break (price back through mid-band) ----
    if (Number.isFinite(mid) && Number.isFinite(close)) {
        if (dir === 'bullish' && close < mid) {
            const inv =
                'breakout setup invalidated: close back below BB middle (failed long break)';
            reasons.push(inv);
            return emptySetupResult({
                reasons,
                diagnostics,
                setupId,
                invalidation: inv,
            });
        }
        if (dir === 'bearish' && close > mid) {
            const inv =
                'breakout setup invalidated: close back above BB middle (failed short break)';
            reasons.push(inv);
            return emptySetupResult({
                reasons,
                diagnostics,
                setupId,
                invalidation: inv,
            });
        }
    }

    // Still outside the broken prior band?
    const stillOutside =
        dir === 'bullish'
            ? Number.isFinite(close) &&
              Number.isFinite(prevUpper) &&
              close > prevUpper
            : Number.isFinite(close) &&
              Number.isFinite(prevLower) &&
              close < prevLower;
    diagnostics.stillOutsideBand = stillOutside;

    if (!stillOutside) {
        const inv =
            'breakout setup invalidated: close no longer outside broken prior band';
        reasons.push(inv);
        return emptySetupResult({
            reasons,
            diagnostics,
            setupId,
            invalidation: inv,
        });
    }

    reasons.push(`breakout setup: structure + direction qualified (${dir})`);

    // ---- Entry trigger: volume (from classifier) + MACD agreement ----
    // Volume is required by the BREAKOUT regime label, but we still check
    // it explicitly so the trigger is inspectable and not implicit.
    // MACD histogram agreement is the independent confirmation that is
    // NOT part of classifyRegime's isBreakout definition.
    const volumeOk = classification.volumeConfirmed === true;
    const macdAgrees =
        dir === 'bullish'
            ? Number.isFinite(histNow) &&
              Number.isFinite(histPrev) &&
              histNow > histPrev &&
              histNow > 0
            : Number.isFinite(histNow) &&
              Number.isFinite(histPrev) &&
              histNow < histPrev &&
              histNow < 0;

    diagnostics.volumeOk = volumeOk;
    diagnostics.macdAgrees = macdAgrees;

    if (!volumeOk) {
        reasons.push(
            'breakout setup: structure present but volume confirmation missing'
        );
        return emptySetupResult({
            reasons,
            diagnostics,
            setupQualified: true,
            entryTriggered: false,
            setupId,
            side: null,
        });
    }

    if (!macdAgrees) {
        reasons.push(
            'breakout setup: structure present but MACD confirmation not fired'
        );
        return emptySetupResult({
            reasons,
            diagnostics,
            setupQualified: true,
            entryTriggered: false,
            setupId,
            side: null,
        });
    }

    reasons.push(
        `breakout setup: confirmation trigger fired → ${side === 'buy' ? 'long' : 'short'} entry`
    );

    return {
        detected: true,
        setupId,
        side,
        setupQualified: true,
        entryTriggered: true,
        invalidation: null,
        reasons,
        diagnostics,
    };
}
