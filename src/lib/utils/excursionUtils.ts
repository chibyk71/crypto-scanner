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

/**
 * Compute the MFE/MAE ratio – key indicator of reward-to-risk efficiency
 * Higher ratio = historically more favorable excursions (good for widening TP)
 */
export function computeExcursionRatio(mfe: number, mae: number): number {
    // Avoid division by zero – treat zero MAE as perfect (infinite ratio)
    return mfe / Math.max(mae, 1e-6);
}

/**
 * Normalize a price excursion (favorable or adverse) to percentage of entry price
 * Used during simulation and when storing MFE/MAE values
 */
export function normalizeExcursion(value: number, entryPrice: number): number {
    if (entryPrice <= 0) {
        throw new Error('Entry price must be positive for normalization');
    }
    return (value / entryPrice) * 100; // Returns percentage (e.g., 3.45 for +3.45%)
}

/**
 * Analyze historical average MFE & MAE and return actionable advice + adjustments
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

export function getExcursionAdvice(avgMfe: number, avgMae: number): ExcursionAdvice {
    const ratio = computeExcursionRatio(avgMfe, avgMae);

    // Default neutral state
    let advice = '⚪ Neutral excursion profile';
    let adjustments = {
        slMultiplier: 1.0,
        tpMultiplier: 1.0,
        confidenceBoost: 0,
    };

    // Good excursion profile: high reward relative to drawdown
    if (ratio >= config.strategy.minExcursionRatio) {
        advice = '🟢 Strong reward potential (high MFE/MAE)';
        adjustments = {
            slMultiplier: 1.1,                                    // Slightly loosen SL (more room to breathe)
            tpMultiplier: 1.2,                                    // Widen TPs to capture more upside
            confidenceBoost: config.strategy.excursionConfidenceBoost, // e.g., +10%
        };
    }
    // Poor excursion profile: large drawdowns vs small gains
    else if (ratio < 1.0) {
        advice = '🔴 High drawdown risk (poor MFE/MAE)';
        adjustments = {
            slMultiplier: 0.9,                                    // Tighten SL to cut losses faster
            tpMultiplier: 1.0,                                    // Keep TP conservative
            confidenceBoost: -0.1,                                // Reduce confidence
        };
    }
    // Moderate but below threshold
    else if (ratio < config.strategy.minExcursionRatio) {
        advice = '🟡 Moderate excursion – cautious approach';
        adjustments = {
            slMultiplier: 1.0,
            tpMultiplier: 1.05,                                   // Small TP expansion
            confidenceBoost: 0.02,                                // Minor boost
        };
    }

    return { advice, adjustments };
}

/**
 * Optional helper: determine if a symbol has unacceptable drawdown risk
 * Used for filtering in autotrading or confidence penalties
 */
export function isHighMaeRisk(avgMae: number): boolean {
    return avgMae > config.strategy.maxMaePct;
}
