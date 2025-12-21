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
    // Avoid division by zero – treat zero MAE as perfect
    return mfe / Math.max(mae, 1e-6);
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
 * Analyze historical average MFE & MAE and return actionable advice + adjustments
 *
 * Priority order:
 *   1. Recent time-bound data (if enough samples) → detects current regime
 *   2. Directional lifetime stats → handles long/short asymmetry
 *   3. Overall lifetime stats → baseline
 *
 * Adjustments are multipliers applied to:
 *   • SL distance (e.g., 0.9 = tighten stop by 10%)
 *   • TP levels (e.g., 1.2 = widen take-profit by 20%)
 *   • Confidence score (e.g., +0.1 = +10% boost)
 */
export interface ExcursionAdvice {
    advice: string; // Human-readable summary with emoji
    adjustments: {
        slMultiplier: number;     // Apply to stop-loss distance
        tpMultiplier: number;     // Apply to all take-profit levels
        confidenceBoost: number;  // Add to final confidence (0.0 to 1.0)
    };
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

    const minRecentSamples = 1;
    const minExcursionRatio = config.strategy.minExcursionRatio ?? 1.8;
    const maxMaePct = config.strategy.maxMaePct ?? 3.0;
    const excursionConfidenceBoost = config.strategy.excursionConfidenceBoost ?? 0.1;

    let selectedMfe = 0;
    let selectedMae = 0;
    let source = 'lifetime';

    // === 1. Prioritize RECENT data if sufficient ===
    if (history.recentSampleCount >= minRecentSamples && history.recentMfe > 0) {
        selectedMfe = history.recentMfe;
        selectedMae = history.recentMae;
        source = 'recent';

        // High recent MAE → high immediate drawdown risk
        if (selectedMae > maxMaePct) {
            advice = '🔴 High recent drawdown risk';
            adjustments = {
                slMultiplier: 0.8,     // Tighten SL aggressively
                tpMultiplier: 0.9,     // Be conservative on TP
                confidenceBoost: -0.15,
            };
            return { advice, adjustments };
        }
    }
    // === 2. Fall back to DIRECTIONAL lifetime stats ===
    else if (direction === 'long') {
        selectedMfe = history.avgMfeLong || history.avgMfe;
        selectedMae = history.avgMaeLong || history.avgMae;
        source = 'directional-long';
    } else {
        selectedMfe = history.avgMfeShort || history.avgMfe;
        selectedMae = history.avgMaeShort || history.avgMae;
        source = 'directional-short';
    }

    // If still no meaningful data, use overall lifetime as last resort
    if (selectedMfe === 0 && selectedMae === 0) {
        selectedMfe = history.avgMfe;
        selectedMae = history.avgMae;
        source = 'overall-lifetime';
    }

    const ratio = computeExcursionRatio(selectedMfe, selectedMae);

    // === Strong reward profile ===
    if (ratio >= minExcursionRatio) {
        advice = `🟢 Strong reward potential (${source})`;
        adjustments = {
            slMultiplier: 1.15,                     // Give more room to breathe
            tpMultiplier: 1.25,                     // Aggressively capture upside
            confidenceBoost: excursionConfidenceBoost,
        };
    }
    // === Poor reward profile (high drawdown relative to gain) ===
    else if (ratio < 1.0 || selectedMae > maxMaePct * 0.9) {
        advice = `🔴 Poor reward-to-risk (${source})`;
        adjustments = {
            slMultiplier: 0.85,                     // Cut losses faster
            tpMultiplier: 0.9,
            confidenceBoost: -0.1,
        };
    }
    // === Moderate but below strong threshold ===
    else if (ratio < minExcursionRatio) {
        advice = `🟡 Moderate excursions (${source})`;
        adjustments = {
            slMultiplier: 1.0,
            tpMultiplier: 1.1,                      // Modest TP expansion
            confidenceBoost: 0.05,
        };
    }

    // Add recent sample context if available
    if (history.recentSampleCount > 0) {
        advice += ` | Recent samples: ${history.recentSampleCount}`;
        if (history.recentReverseCount > 0) {
            advice += ` | Reversals: ${history.recentReverseCount}`;
        }
    }

    return { advice, adjustments };
}

/**
 * Determine if a symbol has unacceptable recent or directional drawdown risk
 */
export function isHighMaeRisk(
    history: EnrichedSymbolHistory,
    direction: 'long' | 'short'
): boolean {
    const maxMaePct = config.strategy.maxMaePct ?? 3.0;

    // Prioritize recent MAE
    if (history.recentSampleCount >= 3 && history.recentMae > maxMaePct) {
        return true;
    }

    // Then directional
    const directionalMae = direction === 'long' ? history.avgMaeLong : history.avgMaeShort;
    if (directionalMae > maxMaePct) {
        return true;
    }

    // Finally overall
    return history.avgMae > maxMaePct;
}