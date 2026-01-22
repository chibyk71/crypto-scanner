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
 * Analyzes the current excursion regime and provides actionable trading advice.
 *
 * 2025 logic – strictly following user-specified rules:
 *
 * 1. Consecutive SL > 2 + MAE significant + MAE >> MFE → reverse
 * 2. High SL count (≥3 and > wins) even if not consecutive → warn, no reverse
 * 3. Consecutive or dominant TP (including partial) + good MFE → strong take
 * 4. Mostly timeouts → check pure excursions (MFE good → take; MAE bad → take+warn)
 * 5. All other cases → hold
 *
 * @param regime    Current regime (full or lite)
 * @param direction Trade direction to evaluate
 */
export function getExcursionAdvice(
    regime: ExcursionRegime | ExcursionRegimeLite,
    direction: 'long' | 'short'
): ExcursionAdvice {
    // ── DEFAULTS ────────────────────────────────────────────────────────────────
    let advice = '⚪ No clear regime signal – holding';
    let action: ExcursionAction = 'skip';
    let adjustments = {
        slMultiplier: 1.0,
        tpMultiplier: 1.0,
        confidenceBoost: 0.0,
    };

    // ── CONFIG THRESHOLDS ───────────────────────────────────────────────────────
    const MIN_SAMPLES = 2;
    const MIN_MFE_PCT = 0.4;   // lowered a bit – more forgiving
    const MIN_MAE_PCT = 0.2;   // MAE must be meaningful to trigger risk
    const EXTREME_RATIO = 2.65;  // MFE/|MAE| < 0.65 → MAE dominates * 0.65
    const SIGNIFICANT_GAP = 0.2;   // |MAE| > MFE + this amount → strong dominance * 1.2
    const HIGH_SL_COUNT = 3;
    const CONSECUTIVE_SL = 2;     // >2 means ≥3
    const DOMINANT_TP_COUNT = 2;

    // ── STEP 1: Data guard – too few samples? ───────────────────────────────────
    if (!ExcursionHistoryCache.hasEnoughSamples(regime, MIN_SAMPLES)) {
        advice = `⚠️ Too few samples (${regime.recentSampleCount ?? 0}/${MIN_SAMPLES}) – holding`;
        adjustments.confidenceBoost = -0.20;
        return { advice, adjustments, action: 'skip' };
    }

    // ── STEP 2: Directional / overall selection ─────────────────────────────────
    let mfe = regime.recentMfe ?? 0;
    let mae = regime.recentMae ?? 0;
    let samples = regime.recentSampleCount ?? 0;
    let source = 'overall';

    if (direction === 'long' && (regime.recentSampleCountLong ?? 0) >= MIN_SAMPLES) {
        mfe = regime.recentMfeLong ?? mfe;
        mae = regime.recentMaeLong ?? mae;
        samples = regime.recentSampleCountLong ?? samples;
        source = 'long';
    } else if (direction === 'short' && (regime.recentSampleCountShort ?? 0) >= MIN_SAMPLES) {
        mfe = regime.recentMfeShort ?? mfe;
        mae = regime.recentMaeShort ?? mae;
        samples = regime.recentSampleCountShort ?? samples;
        source = 'short';
    }

    const absMae = Math.abs(mae);
    const ratio = ExcursionHistoryCache.computeExcursionRatio(mfe, mae);
    // const gap = mfe - absMae;

    // ── STEP 3: Outcome counts & streaks ────────────────────────────────────────
    const oc = regime.outcomeCounts ?? { tp: 0, partial_tp: 0, sl: 0, timeout: 0 };
    const tpCount = oc.tp + oc.partial_tp;
    const slCount = oc.sl;
    const timeoutCount = oc.timeout;
    const total = tpCount + slCount + timeoutCount;

    const timeoutRatio = total > 0 ? timeoutCount / total : 0;

    // SL streak (prefer precomputed)
    let slStreak = regime.slStreak ?? 0;
    if (slStreak === 0 && 'historyJson' in regime && regime.historyJson) {
        for (const e of regime.historyJson) {
            if (e.outcome === 'sl') slStreak++;
            else break;
        }
    }

    // ── STEP 4: Decision tree – exact rules as requested ────────────────────────
    let warnings: string[] = [];

    // Rule 1: Consecutive SL dominant + bad excursion → reverse
    if (
        slStreak >= CONSECUTIVE_SL &&
        absMae >= MIN_MAE_PCT &&
        (ratio < EXTREME_RATIO || absMae > mfe + SIGNIFICANT_GAP)
    ) {
        advice = `🔴 Consecutive SL (${slStreak}) + extreme adverse excursion → taking`;
        action = 'take';
        adjustments = {
            slMultiplier: 0.80,
            tpMultiplier: 1.15,
            confidenceBoost: 0.05,
        };
        return { advice, adjustments, action };
    }

    // Rule 2: High SL count (even non-consecutive) → warn only, no reverse
    if (slCount >= HIGH_SL_COUNT && slCount > tpCount) {
        warnings.push(`High SL count (${slCount}/${total}) – caution`);
        adjustments.confidenceBoost -= 0.20;

        // Still allow take only if MFE is reasonable
        if (mfe >= MIN_MFE_PCT && ratio > 0.9) {
            action = 'take';
            advice = `🟠 High SL (${slCount}) but acceptable MFE → taking with caution`;
        } else {
            action = 'skip';
            advice = `🟠 High SL (${slCount}) + weak MFE → holding`;
        }
    }

    // Rule 3: Consecutive or dominant TP → strong take if MFE good
    const hasConsecutiveTP = (() => {
        if (!('historyJson' in regime) || !regime.historyJson) return false;
        let streak = 0;
        for (const e of regime.historyJson) {
            if (e.outcome === 'tp' || e.outcome === 'partial_tp') streak++;
            else break;
        }
        return streak >= 2;
    })();

    const tpDominant = tpCount >= DOMINANT_TP_COUNT && tpCount > slCount && tpCount > timeoutCount;

    if ((hasConsecutiveTP || tpDominant) && mfe >= MIN_MFE_PCT && ratio > 1.5) {
        advice = `🟢 ${hasConsecutiveTP ? 'Consecutive' : 'Dominant'} TP (${tpCount}) + strong MFE → take`;
        action = 'take';
        adjustments = {
            slMultiplier: 1.20,
            tpMultiplier: 1.35,
            confidenceBoost: 0.25,
        };
        return { advice, adjustments, action };
    }

    // Rule 4: Mostly timeouts → pure excursion fallback
    if (timeoutRatio > 0.6 || timeoutCount >= 4) {
        warnings.push(`Mostly timeouts (${timeoutCount}/${total}) – possible chop`);

        if (mfe >= MIN_MFE_PCT && ratio > 1.2) {
            action = 'take';
            advice = `🟢 Mostly timeouts but good MFE → taking cautiously`;
            adjustments.confidenceBoost = -0.10;
        } else if (absMae >= MIN_MAE_PCT) {
            action = 'take';
            advice = `🟠 Mostly timeouts + high MAE → take but expect drawdown`;
            adjustments.slMultiplier = 0.75;
            adjustments.confidenceBoost = -0.20;
        } else {
            action = 'skip';
            advice = `🟡 Mostly timeouts + weak excursions → holding`;
        }
    }

    // Rule 5: Default – hold unless something strong above triggered
    if (action === 'skip') {
        if (warnings.length > 0) {
            advice = `🟡 Holding – ${warnings.join(' | ')}`;
        } else {
            advice = `🟡 No strong signal from regime – holding`;
        }
    }

    // ── FINAL: Apply accumulated warnings to any action ──────────────────────────
    if (warnings.length > 0 && action !== 'skip') {
        advice += ` | ⚠️ ${warnings.join(' | ')}`;
    }

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
