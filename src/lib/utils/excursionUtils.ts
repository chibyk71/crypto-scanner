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

/**
 * Provides excursion advice for a trading signal based on historical MFE (Maximum Favorable Excursion)
 * and MAE (Maximum Adverse Excursion) metrics. This function analyzes recent trade simulations to decide
 * whether to 'take', 'skip', or 'reverse' a position, while adjusting stop-loss (SL) and take-profit (TP)
 * multipliers and confidence boosts accordingly.
 *
 * The goal is to filter trades for better win rates by requiring strong reward-to-risk profiles, low
 * drawdowns, and validation from recent simulations. It prioritizes directional metrics (long/short) when
 * available, falling back to overall recent metrics.
 *
 * @param history - Enriched historical data for the symbol, including recent MFE/MAE stats and completed simulations.
 * @param direction - The intended trade direction: 'long' or 'short'.
 * @returns An object containing advice string, adjustments (multipliers and confidence boost), and action ('take', 'skip', or 'reverse').
 */
export function getExcursionAdvice(
    history: EnrichedSymbolHistory,
    direction: 'long' | 'short'
): ExcursionAdvice {
    // Initialize default values: neutral advice, no adjustments, and default action to skip for safety.
    let advice = '⚪ Neutral excursion profile';
    let adjustments = {
        slMultiplier: 1.0,    // Stop-loss multiplier (1.0 = no change)
        tpMultiplier: 1.0,    // Take-profit multiplier (1.0 = no change)
        confidenceBoost: 0,   // Confidence adjustment for overall signal strength
    };
    let action: ExcursionAction = 'skip';  // Default to 'skip' to avoid risky trades

    // Retrieve configurable max MAE percentage from strategy config, defaulting to 3.0% if not set.
    const maxMaePct = config.strategy.maxMaePct ?? 3.0;

    // === Tunable Thresholds ===
    // These constants define the criteria for classifying excursions. They are relaxed for crypto volatility:
    // - minSamples: Ensure enough data points for reliable statistics.
    // - minMfe: Minimum favorable excursion required for a 'take' action (e.g., 0.3% profit potential).
    // - minRatio: Minimum MFE / |MAE| ratio for acceptable reward:risk.
    // - minGap: Minimum buffer between MFE and |MAE| to avoid thin margins.
    // - maxReversals: Maximum allowed reversals in recent data for 'take'.
    // - minReversalsForReverse: Minimum reversals needed to trigger legacy reversal logic.
    const minSamples = 2;
    const minMfe = 0.30;
    const minRatio = 1.2;
    const minGap = 0.10;
    const maxReversals = 1;
    const minReversalsForReverse = 2;

    // === Metric Selection ===
    // Prioritize direction-specific recent metrics (e.g., long-only for 'long' trades) if available.
    // Fall back to overall recent metrics if directional data is absent.
    let selectedMfe = history.recentMfe;
    let selectedMae = history.recentMae;
    let selectedSamples = history.recentSampleCount;
    let selectedReversals = history.recentReverseCount;
    let source = 'recent';  // Track the data source for advice string

    if (direction === 'long' && history.recentSampleCountLong > 0) {
        selectedMfe = history.recentMfeLong;
        selectedMae = history.recentMaeLong;
        selectedSamples = history.recentSampleCountLong;
        selectedReversals = history.recentReverseCountLong ?? history.recentReverseCount;  // Fallback if directional reversals unavailable
        source = 'recent-long';
    } else if (direction === 'short' && history.recentSampleCountShort > 0) {
        selectedMfe = history.recentMfeShort;
        selectedMae = history.recentMaeShort;
        selectedSamples = history.recentSampleCountShort;
        selectedReversals = history.recentReverseCountShort ?? history.recentReverseCount;  // Fallback if directional reversals unavailable
        source = 'recent-short';
    }

    // === Early Guards ===
    // Check for excessive drawdown risk early to avoid processing risky profiles.
    if (Math.abs(selectedMae) > maxMaePct) {
        advice = `🔴 High recent drawdown risk (|MAE| > ${maxMaePct}%)`;
        adjustments = {
            slMultiplier: 0.8,     // Tighten SL to reduce exposure
            tpMultiplier: 0.9,     // Slightly reduce TP expectation
            confidenceBoost: -0.15 // Penalize confidence due to high risk
        };
        action = 'skip';
        return { advice, adjustments, action };  // Early return for efficiency
    }

    // Handle cases with no recent data: allow cautiously but with reduced confidence.
    if (selectedSamples === 0) {
        advice = 'ℹ️ No recent excursion data – cautious allow';
        action = 'take';  // Proceed but cautiously
        adjustments.confidenceBoost -= 0.05;  // Minor penalty for lack of data
        return { advice, adjustments, action };  // Early return
    }

    // === Derived Metrics Computation ===
    // Calculate absolute MAE (drawdown magnitude), ratio (reward:risk), and gap (safety buffer).
    const absMae = Math.abs(selectedMae);
    const ratio = computeExcursionRatio(selectedMfe, selectedMae);  // Assumes this helper function is defined elsewhere
    const gap = selectedMfe - absMae;

    // === Last Two Simulations Check ===
    // Analyze the most recent two completed simulations from historyJson (newest first).
    // This validates recent performance to block or trigger reversals based on SL hits and poor ratios.
    const lastTwoCompleted = history.historyJson.slice(0, 2);
    let lastTwoHitSl = false;
    let lastTwoPoorRatio = false;

    if (lastTwoCompleted.length >= 2) {
        // Check if both hit stop-loss (SL)
        lastTwoHitSl = lastTwoCompleted.every(e => e.outcome === 'sl');

        // Compute averages for MFE and |MAE| over the last two
        const avgMfe = lastTwoCompleted.reduce((sum, e) => sum + e.mfe, 0) / 2;
        const avgAbsMae = lastTwoCompleted.reduce((sum, e) => sum + Math.abs(e.mae), 0) / 2;

        // Flag if average drawdown exceeded average reward (poor profile)
        lastTwoPoorRatio = avgAbsMae > avgMfe;
    }

    // === Decision Tree ===
    // Evaluate conditions in priority order: insufficient samples, strong take, reversal, or skip.
    if (selectedSamples < minSamples) {
        // Not enough data: allow cautiously with reduced confidence
        advice = `ℹ️ Insufficient recent samples (${selectedSamples}) – cautious allow`;
        action = 'take';
        adjustments.confidenceBoost -= 0.1;
    } else if (
        selectedMfe >= minMfe &&          // Sufficient profit potential
        ratio >= minRatio &&              // Acceptable reward:risk
        gap >= minGap &&                  // Safety buffer present
        selectedReversals <= maxReversals &&  // Limited reversals
        !lastTwoPoorRatio                 // Recent sims not poor
    ) {
        // Strong profile: recommend 'take' with boosts to TP/SL and confidence
        advice = `🟢 Strong reward phase (${source}) | Samples: ${selectedSamples} | Ratio: ${ratio.toFixed(2)} | Gap: ${gap.toFixed(2)}%`;
        action = 'take';
        adjustments.tpMultiplier *= 1.2;  // Expand TP for more reward
        adjustments.slMultiplier *= 1.1;  // Slightly loosen SL for breathing room
        adjustments.confidenceBoost += 0.15;  // Boost confidence
    } else if (
        lastTwoHitSl && lastTwoPoorRatio  // Recent SL hits with poor ratios: suggest reversal
    ) {
        // Primary reversal condition based on recent simulations
        advice = `🔴 Reversal advised (${source}) | Last 2: SL hits + MAE > MFE | Samples: ${selectedSamples}`;
        action = 'reverse';
        adjustments.tpMultiplier *= 1.1;  // Moderate TP expansion
        adjustments.slMultiplier *= 0.9;  // Tighten SL for protection
        adjustments.confidenceBoost += 0.1;  // Minor confidence boost for opportunistic flip
    } else if (
        absMae >= 0.5 &&                  // High drawdown
        ratio <= 0.8 &&                   // Poor ratio
        gap <= -0.2 &&                    // Negative buffer
        selectedReversals >= minReversalsForReverse  // Sufficient reversals
    ) {
        // Legacy reversal condition for additional reversal detection
        advice = `🔴 Legacy reversal potential (${source}) | High MAE: -${absMae.toFixed(2)}% | Reversals: ${selectedReversals}`;
        action = 'reverse';
        adjustments.tpMultiplier *= 1.1;
        adjustments.slMultiplier *= 0.9;
        adjustments.confidenceBoost += 0.1;
    } else {
        // Default: mixed or weak profile – skip to avoid risk
        advice = `🟡 Poor/mixed excursions (${source}) | Samples: ${selectedSamples} | Ratio: ${ratio.toFixed(2)} | Gap: ${gap.toFixed(2)}%`;
        if (lastTwoPoorRatio) {
            advice += ' | Last 2: MAE > MFE';  // Append extra context if applicable
        }
        action = 'skip';
    }

    // === Enhance Advice String ===
    // Append additional context (samples, reversals) if relevant and not already included, but only for non-skip actions.
    if (selectedSamples > 0 && action !== 'skip') {
        if (!advice.includes('Samples:')) {
            advice += ` | Samples: ${selectedSamples}`;
        }
        if (selectedReversals > 0 && !advice.includes('Reversals:')) {
            advice += ` | Reversals: ${selectedReversals}`;
        }
    }

    // Return the final computed values
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
