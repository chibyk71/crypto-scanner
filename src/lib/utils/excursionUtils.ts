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
    let source = 'none';

    // === 1. Prioritize RECENT overall data ===
    if (history.recentSampleCount >= minRecentSamples && history.recentMfe > 0) {
        selectedMfe = history.recentMfe;
        selectedMae = history.recentMae;
        source = 'recent';

        // High recent drawdown risk (MAE is negative)
        if (Math.abs(selectedMae) > maxMaePct) {
            advice = '🔴 High recent drawdown risk';
            adjustments = {
                slMultiplier: 0.8,
                tpMultiplier: 0.9,
                confidenceBoost: -0.15,
            };
            return { advice, adjustments };
        }
    }
    // === 2. Fall back to RECENT directional data ===
    else if (direction === 'long' && history.recentSampleCountLong > 0) {
        selectedMfe = history.recentMfeLong;
        selectedMae = history.recentMaeLong;
        source = 'recent-long';
    } else if (direction === 'short' && history.recentSampleCountShort > 0) {
        selectedMfe = history.recentMfeShort;
        selectedMae = history.recentMaeShort;
        source = 'recent-short';
    }

    // If no recent data at all
    if (selectedMfe === 0 && selectedMae === 0) {
        advice = 'ℹ️ No recent excursion data';
        return { advice, adjustments };
    }

    const ratio = computeExcursionRatio(selectedMfe, selectedMae);

    // === Strong reward profile ===
    if (ratio >= minExcursionRatio) {
        advice = `🟢 Strong reward potential (${source})`;
        adjustments = {
            slMultiplier: 1.15,
            tpMultiplier: 1.25,
            confidenceBoost: excursionConfidenceBoost,
        };
    }
    // === Poor reward profile ===
    else if (ratio < 1.0 || Math.abs(selectedMae) > maxMaePct * 0.9) {
        advice = `🔴 Poor reward-to-risk (${source})`;
        adjustments = {
            slMultiplier: 0.85,
            tpMultiplier: 0.9,
            confidenceBoost: -0.1,
        };
    }
    // === Moderate ===
    else {
        advice = `🟡 Moderate excursions (${source})`;
        adjustments = {
            slMultiplier: 1.0,
            tpMultiplier: 1.1,
            confidenceBoost: 0.05,
        };
    }

    // Add context
    if (history.recentSampleCount > 0) {
        advice += ` | Samples: ${history.recentSampleCount}`;
        if (history.recentReverseCount > 0) {
            advice += ` | Reversals: ${history.recentReverseCount}`;
        }
    }

    return { advice, adjustments };
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
    if (history.recentSampleCount >= 3 && Math.abs(history.recentMae) > maxMaePct) {
        return true;
    }

    // Then recent directional
    const directionalMae = direction === 'long' ? history.recentMaeLong : history.recentMaeShort;
    if (directionalMae !== 0 && Math.abs(directionalMae) > maxMaePct) {
        return true;
    }

    return false;
}
