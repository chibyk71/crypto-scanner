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
import { ExcursionHistoryCache, type ExcursionRegime, type ExcursionRegimeLite } from '../services/excursionHistoryCache';

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
 * Analyzes the current excursion regime and provides actionable trading advice for a given direction.
 *
 * This is the central decision-making function for excursion-based filtering and adjustment.
 * It helps the system decide whether to:
 *   - 'take' the original signal (strong reward profile)
 *   - 'reverse' (flip direction due to poor performance in intended direction)
 *   - 'skip' (avoid trade due to weak/mixed/dangerous profile)
 *
 * Core goals:
 * - Maximize reward-to-risk by favoring directions with historically favorable excursions
 * - Protect capital by skipping or reversing when drawdowns (MAE) are too large
 * - Provide human-readable explanations + confidence/SL/TP adjustments for strategy & UI
 *
 * Key safety principles:
 * - Always defaults to 'skip' on missing/insufficient data
 * - Prioritizes directional metrics when available (most accurate)
 * - Requires minimum samples before trusting statistics
 * - Guards against missing `historyJson` (Lite regime version)
 *
 * @param regime - Current regime data from `excursionCache` (full or lightweight version)
 * @param direction - The intended trade direction we're evaluating ('long' or 'short')
 * @returns Advice object with:
 *   - `advice`: Human-readable string (with emoji) for logs/alerts
 *   - `adjustments`: Multipliers/boosts to apply to SL/TP/confidence
 *   - `action`: Final decision ('take' | 'reverse' | 'skip')
 */
export function getExcursionAdvice(
    regime: ExcursionRegime,
    direction: 'long' | 'short'
): ExcursionAdvice {
    // ── DEFAULTS: Always start conservative ──────────────────────────────────────
    // Skip is the safest default when data is missing or unclear
    let advice = '⚪ Neutral / insufficient data – skipping';
    let action: ExcursionAction = 'skip';
    let adjustments = {
        slMultiplier: 1.0,       // 1.0 = no change to stop-loss distance
        tpMultiplier: 1.0,       // 1.0 = no change to take-profit levels
        confidenceBoost: -0.10,  // Slight penalty until proven otherwise
    };

    // ── CONFIGURATION: All tunable thresholds in one place ───────────────────────
    // These values are relaxed for crypto volatility but still protective
    const MAX_MAE_PCT = config.strategy.maxMaePct ?? 3.0;
    const MIN_SAMPLES = 3;            // Require at least 3 closed trades to trust stats
    const MIN_MFE_PCT = 0.5;         // Minimum average favorable move needed to consider 'take'
    const MIN_RATIO = 2.5;            // MFE / |MAE| must be meaningfully > 1
    const MIN_GAP_PCT = 0.25;         // Safety buffer between best profit and worst loss
    const MAX_SAFE_REVERSALS = 1;     // More than this → caution / potential reversal
    const MIN_REVERSALS_FOR_REVERSE = 2; // Need at least this many to suggest flip

    // ── STEP 1: Select the most relevant metrics (directional > overall) ─────────
    let selectedMfe = regime.recentMfe ?? 0;
    let selectedMae = regime.recentMae ?? 0;
    let selectedSamples = regime.recentSampleCount ?? 0;
    let selectedReversals = regime.recentReverseCount ?? 0;
    let sourceLabel = 'overall-recent';

    // Prefer directional data when sufficient samples exist
    if (direction === 'long' && (regime.recentSampleCountLong ?? 0) >= MIN_SAMPLES) {
        selectedMfe = regime.recentMfeLong ?? selectedMfe;
        selectedMae = regime.recentMaeLong ?? selectedMae;
        selectedSamples = regime.recentSampleCountLong ?? selectedSamples;
        selectedReversals = regime.recentReverseCountLong ?? selectedReversals;
        sourceLabel = 'long-directional';
    } else if (direction === 'short' && (regime.recentSampleCountShort ?? 0) >= MIN_SAMPLES) {
        selectedMfe = regime.recentMfeShort ?? selectedMfe;
        selectedMae = regime.recentMaeShort ?? selectedMae;
        selectedSamples = regime.recentSampleCountShort ?? selectedSamples;
        selectedReversals = regime.recentReverseCountShort ?? selectedReversals;
        sourceLabel = 'short-directional';
    }

    // ── STEP 2: Early safety guards – skip fast if clearly dangerous ─────────────
    const absMae = Math.abs(selectedMae);

    // Guard 1: Excessive drawdown → immediate skip (safety first)
    if (absMae > MAX_MAE_PCT) {
        advice = `🔴 Dangerous drawdown risk (|MAE| = ${absMae.toFixed(2)}% > ${MAX_MAE_PCT}%)`;
        adjustments = {
            slMultiplier: 0.75,      // Significantly tighten stop-loss
            tpMultiplier: 0.85,      // Reduce profit expectation
            confidenceBoost: -0.25,  // Heavy confidence penalty
        };
        action = 'skip';
        return { advice, adjustments, action };
    }

    // Guard 2: Not enough data → cautious allow but low confidence
    if (selectedSamples < MIN_SAMPLES) {
        advice = `⚠️ Too few recent samples (${selectedSamples}/${MIN_SAMPLES}) – cautious mode only`;
        adjustments.confidenceBoost = -0.15;
        action = 'skip'; // Allow but with reduced size/confidence in caller
        return { advice, adjustments, action };
    }

    // ── STEP 3: Derived metrics used in decision tree ────────────────────────────
    const ratio = ExcursionHistoryCache.computeExcursionRatio(selectedMfe, selectedMae);
    const gap = selectedMfe - absMae;

    // ── STEP 4: Last-two completed simulations validation (strongest signal) ─────
    // Only possible in full regime; safely fallback to empty in Lite version
    const lastTwoCompleted = regime.historyJson?.slice(0, 2) ?? [];
    let lastTwoHitSl = false;
    let lastTwoPoorRatio = false;

    if (lastTwoCompleted.length >= 2) {
        lastTwoHitSl = lastTwoCompleted.every(e => e.outcome === 'sl');

        const avgMfe = lastTwoCompleted.reduce((sum, e) => sum + e.mfe, 0) / 2;
        const avgAbsMae = lastTwoCompleted.reduce((sum, e) => sum + Math.abs(e.mae), 0) / 2;
        lastTwoPoorRatio = avgAbsMae > avgMfe;
    }

    // ── STEP 5: Main decision tree (priority order: strongest signal first) ──────
    if (
        selectedMfe >= MIN_MFE_PCT &&
        ratio >= MIN_RATIO &&
        gap >= MIN_GAP_PCT &&
        selectedReversals <= MAX_SAFE_REVERSALS &&
        !lastTwoPoorRatio
    ) {
        // Strongest positive signal: good reward potential, low risk
        advice = `🟢 Strong ${sourceLabel} profile | Samples: ${selectedSamples} | Ratio: ${ratio.toFixed(2)} | Gap: +${gap.toFixed(2)}%`;
        action = 'take';
        adjustments = {
            slMultiplier: 1.15,       // Give more breathing room
            tpMultiplier: 1.25,       // Stretch for more reward
            confidenceBoost: 0.20,    // Significant boost
        };
    } else if (lastTwoHitSl && lastTwoPoorRatio) {
        // Very strong reversal signal: recent closed trades failed badly
        advice = `🔴 Clear reversal signal (${sourceLabel}) | Last 2 closed: SL hits + poor ratio`;
        action = 'reverse';
        adjustments = {
            slMultiplier: 0.85,       // Protect more aggressively
            tpMultiplier: 1.10,       // Still allow some upside on flip
            confidenceBoost: 0.10,    // Mild boost (reversals are opportunistic)
        };
    } else if (
        selectedReversals >= MIN_REVERSALS_FOR_REVERSE &&
        ratio <= 0.85 &&
        gap <= -0.10
    ) {
        // Secondary reversal condition: multiple failures + poor metrics
        advice = `🟠 Reversal potential (${sourceLabel}) | Reversals: ${selectedReversals} | Weak ratio & gap`;
        action = 'reverse';
        adjustments = {
            slMultiplier: 0.90,
            tpMultiplier: 1.05,
            confidenceBoost: 0.05,
        };
    } else {
        // Default: mixed, weak, or unclear → safest choice is skip
        advice = `🟡 Mixed/weak profile (${sourceLabel}) | Samples: ${selectedSamples} | Ratio: ${ratio.toFixed(2)}`;
        if (lastTwoPoorRatio) advice += ' | Recent 2: poor MFE/MAE';
        action = 'skip';
        adjustments.confidenceBoost = -0.10;
    }

    // ── STEP 6: Final enhancement of advice string (better readability) ───────────
    if (selectedSamples > 0 && action !== 'skip') {
        advice += ` | Reversals: ${selectedReversals}`;
    }

    // ── Done! ────────────────────────────────────────────────────────────────────
    return { advice, adjustments, action };
}

/**
 * Determine if a symbol has unacceptable recent drawdown risk
 */
export function isHighMaeRisk(
    regime: ExcursionRegime | ExcursionRegimeLite,
    direction: 'long' | 'short'
): boolean {
    const maxMaePct = config.strategy.maxMaePct ?? 3.0;
    const minSamples = 2;

    // Require minimum samples to trust the MAE value
    if (regime.recentSampleCount < minSamples) {
        return false; // Not enough data → not high risk (conservative)
    }

    // Prioritize directional MAE if available
    let maeToCheck: number | undefined;
    if (direction === 'long') {
        maeToCheck = regime.recentMaeLong;
    } else {
        maeToCheck = regime.recentMaeShort;
    }

    // Fallback to overall
    if (maeToCheck === undefined) {
        maeToCheck = regime.recentMae;
    }

    return Math.abs(maeToCheck ?? 0) > maxMaePct;
}
