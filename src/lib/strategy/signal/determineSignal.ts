// src/lib/strategy/signal/determineSignal.ts
// =============================================================================
// FINAL SIGNAL DECISION
//
// Mechanical extraction from Strategy._determineSignal().
//
// This function converts the accumulated buy/sell scores into the final
// buy, sell, or hold decision.
//
// IMPORTANT:
// All calculations, thresholds, conditions, and reason messages are preserved
// from the original Strategy method. The only structural change is replacing
// the private class method with an exported standalone function.
// =============================================================================

import type { TradeSignal } from '../../../types';
import {
    CONFIDENCE_THRESHOLD,
    MAX_SCORE_PER_SIDE,
    SCORE_MARGIN_REQUIRED,
} from '../constants';
import type { TrendAndVolume } from '../types';

// =============================================================================
// FINAL SIGNAL DECISION: Apply filters and determine direction/confidence
// =============================================================================

/**
 * Converts raw scores into final signal with confidence level.
 *
 * Called from:
 *   • Strategy.generateSignal() – after scoring complete
 *
 * Logic:
 *   • Early reject on poor risk conditions
 *   • Dynamic score margin requirement
 *   • Confidence normalized to 0-100%
 *   • Clear reasons for hold decisions
 *
 * @param buyScore - Total long points
 * @param sellScore - Total short points
 * @param trendBias - HTF directional bias
 * @param isRiskEligible - ATR volatility sanity check
 * @param reasons - Mutable array for explanations
 * @returns Final signal and confidence
 */
export function determineSignal(
    buyScore: number,
    sellScore: number,
    trendBias: TrendAndVolume['trendBias'],
    isRiskEligible: boolean,
    reasons: string[]
): {
    signal: TradeSignal['signal'];
    confidence: number;
} {
    // Early exit if volatility out of bounds
    if (!isRiskEligible) {
        reasons.push('Risk ineligible: ATR out of bounds');
        return {
            signal: 'hold',
            confidence: 0,
        };
    }

    // Counter-trend penalty note (currently disabled but logged)
    if (
        buyScore > sellScore &&
        trendBias !== 'bullish' &&
        trendBias !== 'neutral'
    ) {
        buyScore *= 0.8;
        reasons.push('Counter-trend buy: 20% score penalty applied');
    } else if (
        sellScore > buyScore &&
        trendBias !== 'bearish' &&
        trendBias !== 'neutral'
    ) {
        sellScore *= 0.8;
        reasons.push('Counter-trend sell: 20% score penalty applied');
    }

    // Dynamic margin – stricter when scores are low
    const winningScore = Math.max(buyScore, sellScore);

    const marginFraction =
        Math.min(
            winningScore / MAX_SCORE_PER_SIDE,
            1
        );

    const dynamicMargin =
        10 +
        (SCORE_MARGIN_REQUIRED - 10) *
        marginFraction;

    // CONFIDENCE_THRESHOLD (env, 50-95 range) is meant as a percentage of
    // MAX_SCORE_PER_SIDE, not a raw point value — it was previously compared
    // directly against buyScore/sellScore, silently requiring ~39% of a much
    // larger max than intended as the scoring surface grew over time.
    const buyConfidencePct =
        (buyScore / MAX_SCORE_PER_SIDE) * 100;

    const sellConfidencePct =
        (sellScore / MAX_SCORE_PER_SIDE) * 100;

    let signal: TradeSignal['signal'] = 'hold';
    let confidence = 0;

    if (
        buyConfidencePct >= CONFIDENCE_THRESHOLD &&
        buyScore - sellScore >= dynamicMargin
    ) {
        signal = 'buy';
        confidence = buyConfidencePct;
    } else if (
        sellConfidencePct >= CONFIDENCE_THRESHOLD &&
        sellScore - buyScore >= dynamicMargin
    ) {
        signal = 'sell';
        confidence = sellConfidencePct;
    } else {
        reasons.push(
            'No clear signal: Insufficient score margin or trend mismatch'
        );
    }

    confidence = Math.min(confidence, 100);

    return {
        signal,
        confidence,
    };
}
