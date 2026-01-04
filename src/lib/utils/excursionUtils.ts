// src/lib/utils/excursionUtils.ts
// =============================================================================
// EXCURSION UTILITIES – MAE / MFE ANALYSIS & STRATEGY ADJUSTMENTS
// Central source for excursion-based logic used in:
//   • Strategy (dynamic SL/TP & confidence adjustments)
//   • AutoTradeService (risk filtering)
//   • MLService (additional features)
//   • Scanner & Telegram alerts (visual feedback)
// =============================================================================

import { config } from '../config/settings';
import type { EnrichedSymbolHistory } from '../db';

/**
 * Compute the MFE/MAE ratio – key indicator of reward-to-risk efficiency
 * Higher ratio = historically more favorable excursions (good for widening TP)
 */
export function computeExcursionRatio(mfe: number, mae: number): number {
    // MAE is negative → use absolute value
    return mfe / Math.max(Math.abs(mae), 1e-6);
}

/**
 * Normalize a price excursion (favorable or adverse) to percentage of entry price
 */
export function normalizeExcursion(value: number, entryPrice: number): number {
    if (entryPrice <= 0) {
        throw new Error('Entry price must be positive for normalization');
    }
    return (value / entryPrice) * 100; // Returns percentage (e.g., 3.45%)
}

/**
 * Possible actions returned by excursion analysis
 */
export type ExcursionAction = 'take' | 'reverse' | 'skip';

/**
 * Analyze recent MFE & MAE and return actionable advice + adjustments
 *
 * Uses only recent data (~3h + live):
 *   1. Recent overall
 *   2. Recent directional (long/short)
 *
 * Adjustments are multipliers applied to:
 *   • SL distance (e.g., 0.9 = tighten stop by 10%)
 *   • TP levels (e.g., 1.2 = widen take-profit by 20%)
 *   • Confidence score (e.g., +0.1 = +10% boost)
 *
 * New behavior:
 *   • Returns an explicit action: 'take' (original direction), 'reverse' (flip buy/sell), or 'skip'
 *   • Decision based on MFE, MAE, ratio, gap, reversals, and sample count
 */
export interface ExcursionAdvice {
    advice: string; // Human-readable summary with emoji
    adjustments: {
        slMultiplier: number;     // Apply to stop-loss distance
        tpMultiplier: number;     // Apply to all take-profit levels
        confidenceBoost: number;  // Add to final confidence (0.0 to 1.0)
    };
    action: ExcursionAction;      // Core decision: take, reverse, or skip
}

export function getExcursionAdvice(
    history: EnrichedSymbolHistory,
    direction: 'long' | 'short'
): ExcursionAdvice {
    // Default neutral state
    let advice = '⚪ Neutral excursion profile';
    let adjustments = {
        slMultiplier: 1.0,
        tpMultiplier: 1.0,
        confidenceBoost: 0,
    };
    let action: ExcursionAction = 'skip';

    const maxMaePct = config.strategy.maxMaePct ?? 3.0;

    // === Tunable thresholds (hardcoded for now – can be moved to config later) ===
    const minSamples = 2;
    const minMfe = 0.30;           // Minimum MFE % to consider "strong reward"
    const maxMae = 0.30;           // Maximum |MAE| % for reversal trigger
    const minRatio = 1.5;          // Minimum MFE/|MAE| ratio for clean reward phase
    const minGap = 0.25;           // Minimum (MFE - |MAE|) % buffer to avoid whipsaw
    const maxReversals = 1;        // Max reversals allowed for "take"
    const minReversalsForReverse = 2; // Minimum reversals needed to trigger reversal

    // === Select metrics: prioritize overall recent, then directional ===
    let selectedMfe = history.recentMfe;
    let selectedMae = history.recentMae;
    let selectedSamples = history.recentSampleCount;
    let selectedReversals = history.recentReverseCount;
    let source = 'recent';

    if (direction === 'long' && history.recentSampleCountLong > 0) {
        selectedMfe = history.recentMfeLong;
        selectedMae = history.recentMaeLong;
        selectedSamples = history.recentSampleCountLong;
        selectedReversals = history.recentReverseCountLong ?? history.recentReverseCount;
        source = 'recent-long';
    } else if (direction === 'short' && history.recentSampleCountShort > 0) {
        selectedMfe = history.recentMfeShort;
        selectedMae = history.recentMaeShort;
        selectedSamples = history.recentSampleCountShort;
        selectedReversals = history.recentReverseCountShort ?? history.recentReverseCount;
        source = 'recent-short';
    }

    // === Early high drawdown guard (unchanged from original logic) ===
    if (Math.abs(selectedMae) > maxMaePct) {
        advice = '🔴 High recent drawdown risk';
        adjustments = {
            slMultiplier: 0.8,
            tpMultiplier: 0.9,
            confidenceBoost: -0.15,
        };
        action = 'skip';
        return { advice, adjustments, action };
    }

    // === No recent data at all ===
    if (selectedMfe === 0 && selectedMae === 0) {
        advice = 'ℹ️ No recent excursion data';
        action = 'take'; // Fallback: allow original signal but no boost
        adjustments.confidenceBoost -= 0.05;
        return { advice, adjustments, action };
    }

    // === Compute derived metrics ===
    const absMae = Math.abs(selectedMae);
    const ratio = computeExcursionRatio(selectedMfe, selectedMae);
    const gap = selectedMfe - absMae; // Positive = clean upside buffer

    // === Decision tree ===
    if (selectedSamples < minSamples) {
        // Not enough data → be cautious but don't block entirely
        advice = `ℹ️ Insufficient recent samples (${selectedSamples}) – neutral`;
        action = 'take';
        adjustments.confidenceBoost -= 0.1;
    } else if (
        selectedMfe >= minMfe &&
        ratio >= minRatio &&
        gap >= minGap &&
        selectedReversals <= maxReversals
    ) {
        // Strong, clean reward phase → take original direction with boost
        advice = `🟢 Strong reward phase (${source}) | Samples: ${selectedSamples} | Ratio: ${ratio.toFixed(2)} | Gap: ${gap.toFixed(2)}%`;
        action = 'take';
        adjustments.tpMultiplier *= 1.2;
        adjustments.slMultiplier *= 1.1;   // Loosen SL slightly – low risk
        adjustments.confidenceBoost += 0.15;
    } else if (
        absMae >= maxMae &&
        ratio <= 0.8 &&
        gap <= -0.2 &&
        selectedReversals >= minReversalsForReverse
    ) {
        // Strong adverse excursions + reversals → reverse the signal
        advice = `🔴 Strong reversal potential (${source}) | Samples: ${selectedSamples} | High MAE: -${absMae.toFixed(2)}% | Reversals: ${selectedReversals}`;
        action = 'reverse';
        adjustments.tpMultiplier *= 1.1;
        adjustments.slMultiplier *= 0.9;   // Tighten SL – reversal is riskier
        adjustments.confidenceBoost += 0.1;
    } else {
        // Everything else: mixed, weak, or unclear regime
        advice = `🟡 Poor/mixed excursions (${source}) | Samples: ${selectedSamples} | Ratio: ${ratio.toFixed(2)} | Gap: ${gap.toFixed(2)}% – skipping`;
        action = 'skip';
    }

    // === Add context to advice string (preserve original behavior) ===
    if (history.recentSampleCount > 0 && action !== 'skip') {
        if (!advice.includes('Samples:')) {
            advice += ` | Samples: ${selectedSamples}`;
        }
        if (selectedReversals > 0 && !advice.includes('Reversals:')) {
            advice += ` | Reversals: ${selectedReversals}`;
        }
    }

    return { advice, adjustments, action };
}

/**
 * Determine if a symbol has unacceptable recent drawdown risk
 */
export function isHighMaeRisk(
    history: EnrichedSymbolHistory,
    direction: 'long' | 'short'
): boolean {
    const maxMaePct = config.strategy.maxMaePct ?? 3.0;

    // Prioritize recent overall
    if (history.recentSampleCount >= 2 && Math.abs(history.recentMae) > maxMaePct) {
        return true;
    }

    // Then recent directional
    const directionalMae = direction === 'long' ? history.recentMaeLong : history.recentMaeShort;
    if (directionalMae !== 0 && Math.abs(directionalMae) > maxMaePct) {
        return true;
    }

    return false;
}
