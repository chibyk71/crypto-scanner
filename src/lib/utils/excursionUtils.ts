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
 * Updated 2025 logic:
 *   - Minimum trusted samples lowered to 2
 *   - Outcome counts and slStreak drive early warnings (not hard blocks)
 *   - Extreme adverse ratio triggers reverse — but overridden by consecutive SL
 *   - Warnings added to advice instead of always skipping
 *   - Confidence penalties applied on risky outcome patterns
 *
 * Goals:
 *   - Favor directions with historically good reward/risk
 *   - Protect capital with warnings on high SL or choppy (timeout-heavy) regimes
 *   - Suggest reversal on extreme adverse excursions — but avoid fighting strong trends (consec SL)
 *   - Always provide readable explanations + adjustment multipliers
 *
 * @param regime - Current regime (full or lite) from excursionCache
 * @param direction - Trade direction to evaluate ('long' | 'short')
 * @returns Advice object with human-readable string, adjustments, and final action
 */
export function getExcursionAdvice(
    regime: ExcursionRegime,
    direction: 'long' | 'short'
): ExcursionAdvice {
    // ── DEFAULTS: Start conservative ─────────────────────────────────────────────
    let advice = '⚪ Neutral / insufficient data – skipping';
    let action: ExcursionAction = 'skip';
    let adjustments = {
        slMultiplier: 1.0,
        tpMultiplier: 1.0,
        confidenceBoost: -0.10,
    };

    // ── CONFIGURATION: Tunable thresholds (move to config later if needed) ────────
    const MAX_MAE_PCT = config.strategy?.maxMaePct ?? 3.0;
    const MIN_SAMPLES = 2;                      // lowered per 2025 plan
    const MIN_MFE_PCT = 0.5;
    const MIN_RATIO = 2.0;                      // relaxed from 2.5
    const MIN_GAP_PCT = 0.20;
    const EXTREME_RATIO_THRESHOLD = 0.6;        // ratio < 0.6 → adverse dominance
    const MIN_GAP_FOR_EXTREME = 0.5;            // |MAE| must exceed MFE by at least this
    const HIGH_SL_COUNT = 3;                    // ≥3 SL → strong warning
    const HIGH_TIMEOUT_COUNT = 3;               // ≥3 timeouts → choppy market warning
    const HIGH_TIMEOUT_RATIO = 0.5;             // >50% timeouts → ranging warning
    const MAX_SAFE_REVERSALS = 1;
    const MIN_REVERSALS_FOR_REVERSE = 2;

    // ── STEP 1: Early guard – insufficient data? ─────────────────────────────────
    if (!ExcursionHistoryCache.hasEnoughSamples(regime, MIN_SAMPLES)) {
        advice = `⚠️ Too few recent samples (${regime.recentSampleCount ?? 0}/${MIN_SAMPLES}) – cautious skip`;
        adjustments.confidenceBoost = -0.25;
        action = 'skip';
        return { advice, adjustments, action };
    }

    // ── STEP 2: Select directional or overall metrics ────────────────────────────
    let selectedMfe = regime.recentMfe ?? 0;
    let selectedMae = regime.recentMae ?? 0;
    let selectedSamples = regime.recentSampleCount ?? 0;
    let selectedReversals = regime.recentReverseCount ?? 0;
    let sourceLabel = 'overall-recent';

    if (direction === 'long' && (regime.recentSampleCountLong ?? 0) >= MIN_SAMPLES) {
        selectedMfe = regime.recentMfeLong ?? selectedMfe;
        selectedMae = regime.recentMaeLong ?? selectedMae;
        selectedSamples = regime.recentSampleCountLong ?? selectedSamples;
        selectedReversals = regime.recentReverseCount ?? selectedReversals;
        sourceLabel = 'long-directional';
    } else if (direction === 'short' && (regime.recentSampleCountShort ?? 0) >= MIN_SAMPLES) {
        selectedMfe = regime.recentMfeShort ?? selectedMfe;
        selectedMae = regime.recentMaeShort ?? selectedMae;
        selectedSamples = regime.recentSampleCountShort ?? selectedSamples;
        selectedReversals = regime.recentReverseCount ?? selectedReversals;
        sourceLabel = 'short-directional';
    }

    // ── STEP 3: Early outcome-based warnings (before metrics) ─────────────────────
    const outcomeCounts = regime.outcomeCounts ?? { tp: 0, partial_tp: 0, sl: 0, timeout: 0 };
    const slCount = outcomeCounts.sl;
    const tpCount = outcomeCounts.tp + outcomeCounts.partial_tp;
    const timeoutCount = outcomeCounts.timeout;
    const timeoutRatio = regime.timeoutRatio ?? 0;

    let warningParts: string[] = [];

    // High SL count → warning + confidence penalty, but still allow 'take'
    if (slCount > tpCount || slCount >= HIGH_SL_COUNT) {
        warningParts.push(`High SL rate (${slCount}/${selectedSamples})`);
        adjustments.confidenceBoost -= 0.15;
    }

    // High timeouts → choppy/ranging market warning
    if (timeoutCount >= HIGH_TIMEOUT_COUNT || timeoutRatio > HIGH_TIMEOUT_RATIO) {
        warningParts.push(`Many timeouts (${timeoutCount}/${selectedSamples} – possible ranging)`);
        adjustments.confidenceBoost -= 0.10;
    }

    // ── STEP 4: Get SL streak (prefer precomputed, fallback to manual count) ──────
    let slStreak = regime.slStreak ?? 0;
    if (slStreak === 0 && regime.historyJson) {
        // Manual fallback (newest first)
        for (const e of regime.historyJson) {
            if (e.outcome === 'sl') slStreak++;
            else break;
        }
    }

    if (slStreak >= 2) {
        warningParts.push(`Consecutive SL detected (${slStreak}) – reversal may be risky`);
        adjustments.confidenceBoost -= 0.10;
    }

    // ── STEP 5: Core metrics ─────────────────────────────────────────────────────
    const absMae = Math.abs(selectedMae);
    const ratio = ExcursionHistoryCache.computeExcursionRatio(selectedMfe, selectedMae);
    const gap = selectedMfe - absMae;

    // ── STEP 6: Excessive drawdown guard (still strongest safety check) ──────────
    if (absMae > MAX_MAE_PCT) {
        advice = `🔴 Dangerous drawdown risk (|MAE| ${absMae.toFixed(2)}% > ${MAX_MAE_PCT}%)`;
        adjustments.slMultiplier = 0.70;
        adjustments.tpMultiplier = 0.80;
        adjustments.confidenceBoost = -0.30;
        action = 'skip';
        if (warningParts.length) advice += ` | ${warningParts.join(' | ')}`;
        return { advice, adjustments, action };
    }

    // ── STEP 7: Main decision tree (strongest signals first) ─────────────────────
    let baseAdvice = `(${sourceLabel}) Samples: ${selectedSamples} | Ratio: ${ratio.toFixed(2)}`;

    if (
        selectedMfe >= MIN_MFE_PCT &&
        ratio >= MIN_RATIO &&
        gap >= MIN_GAP_PCT &&
        selectedReversals <= MAX_SAFE_REVERSALS
    ) {
        // Strong positive profile
        advice = `🟢 Strong profile | ${baseAdvice} | Gap: +${gap.toFixed(2)}%`;
        action = 'take';
        adjustments = {
            slMultiplier: 1.15,
            tpMultiplier: 1.25,
            confidenceBoost: 0.20,
        };
    } else if (
        ratio < EXTREME_RATIO_THRESHOLD &&
        absMae > selectedMfe + MIN_GAP_FOR_EXTREME
    ) {
        // Extreme adverse excursion → consider reverse
        if (slStreak >= 2) {
            // But consecutive SL → don't fight the trend
            advice = `🟠 Extreme adverse ratio but consecutive SL (${slStreak}) – take with caution`;
            action = 'take';
            adjustments.confidenceBoost = -0.15;
        } else {
            advice = `🔴 Extreme adverse ratio (${ratio.toFixed(2)}) – reversing`;
            action = 'reverse';
            adjustments = {
                slMultiplier: 0.85,
                tpMultiplier: 1.10,
                confidenceBoost: 0.10,
            };
        }
    } else if (selectedReversals >= MIN_REVERSALS_FOR_REVERSE && ratio <= 0.85) {
        // Secondary reversal signal
        advice = `🟠 Reversal potential | ${baseAdvice} | Reversals: ${selectedReversals}`;
        action = 'reverse';
        adjustments = {
            slMultiplier: 0.90,
            tpMultiplier: 1.05,
            confidenceBoost: 0.05,
        };
    } else {
        // Mixed / weak → safest is skip, but allow take with penalty if outcomes ok
        advice = `🟡 Mixed/weak profile | ${baseAdvice}`;
        action = 'skip';
        adjustments.confidenceBoost = -0.15;
    }

    // ── STEP 8: Apply outcome warnings to any action ─────────────────────────────
    if (warningParts.length > 0) {
        advice += ` | ⚠️ ${warningParts.join(' | ')}`;
        // Extra confidence penalty if multiple warnings
        if (warningParts.length >= 2) adjustments.confidenceBoost -= 0.10;
    }

    // ── STEP 9: Final touch-ups ──────────────────────────────────────────────────
    if (action !== 'skip') {
        advice += ` | Reversals: ${selectedReversals}`;
    }

    // ── Done ─────────────────────────────────────────────────────────────────────
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
