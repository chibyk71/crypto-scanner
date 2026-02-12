// src/lib/utils/excursionUtils.ts
// =============================================================================
// EXCURSION UTILITIES – MAE / MFE ANALYSIS & STRATEGY ADJUSTMENTS
// Central source for excursion-based logic used in:
//   • Strategy (dynamic SL/TP & confidence adjustments)
//   • AutoTradeService (risk filtering)
//   • MLService (additional features)
//   • Scanner & Telegram alerts (visual feedback)
// =============================================================================

import type { SimulationHistoryEntry } from '../../types/signalHistory';
import { createLogger } from '../logger';
import { excursionCache, ExcursionHistoryCache, type ExcursionRegime, type ExcursionRegimeLite } from '../services/excursionHistoryCache';

const logger = createLogger('ExcursionUtils');

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
 * Result of excursion regime scoring
 */
export interface ExcursionScore {
    totalScore: number;           // Final weighted average score
    baseScore: number;            // Average base score from individual sims
    timeModifier: number;         // Adjustment from duration & time-to-MFE/MAE
    trendModifier?: number;       // Future: slope of recent scores
    individualScores: number[];   // Raw scores per recent simulation (for debugging)
}


// ==============================================================================
// CONSTANTS
// =============================================================================
const MAX_SIMS = 10; // Maximum number of recent sims to consider

/**
 * Analyze recent regime and return actionable advice + adjustments
 *
 * Core 2025 logic – score-based regime evaluation for scalping:
 *
 * 1. Compute score per recent simulation (0–5 base + time modifiers)
 *    - Rewards clear wins (TP/partial_tp) highest
 *    - Rewards timeouts with strong MFE (good move but didn't hit TP)
 *    - Penalizes clean losses (SL with no meaningful MFE)
 *    - Adjusts with duration and time-to-MFE/MAE (fast good moves = higher score)
 *
 * 2. Calculate weighted average score
 *    - Most recent simulations weighted more heavily (exponential decay)
 *    - Directional preference when enough long/short data
 *
 * 3. Map final score to trading decision:
 *    - ≥ 3.8 → strong take (high confidence, wider TP)
 *    - 3.0–3.7 → take (normal confidence)
 *    - 2.0–2.9 → cautious take (reduced size)
 *    - 1.0–1.9 → skip or very small
 *    - ≤ 0.9 → reverse or strong skip
 *
 * 4. Generate human-readable advice string with emojis and warnings
 *
 * Tunable parameters (all configurable later via config):
 * - MFE threshold for "good" timeout/SL = 2.0%
 * - Duration thresholds: <4 min = fast, >7 min = slow
 * - Time-to-MFE: <90s = very fast, >360s = slow
 * - Weights: most recent sim = 2.0×, then 1.5×, 1.2×, etc.
 *
 * @param regime - Full or lightweight regime object from cache
 * @param direction - Intended trade direction ('long' = buy, 'short' = sell)
 * @returns ExcursionAdvice with action, adjustments, and readable advice string
 */
export function getExcursionAdvice(
    regime: ExcursionRegime | ExcursionRegimeLite,
    direction: 'long' | 'short'
): ExcursionAdvice {
    // ────────────────────────────────────────────────────────────────
    // 1. EARLY GUARD: Not enough samples → conservative skip
    // ────────────────────────────────────────────────────────────────
    if (!ExcursionHistoryCache.hasEnoughSamples(regime, 3)) {
        return {
            advice: `⚠️ Too few recent simulations (${regime.recentSampleCount ?? 0}/3) – holding`,
            adjustments: {
                slMultiplier: 1.0,
                tpMultiplier: 1.0,
                confidenceBoost: -0.25, // heavy penalty for no data
            },
            action: 'skip'
        };
    }

    // ────────────────────────────────────────────────────────────────
    // 2. SELECT DIRECTIONAL OR OVERALL DATA (prefer directional)
    // ────────────────────────────────────────────────────────────────
    let targetRegime: ExcursionRegime | ExcursionRegimeLite = regime;

    if (direction === 'long' && regime.recentSampleCountLong && regime.recentSampleCountLong >= 2) {
        // Use directional long data if enough samples
        targetRegime = {
            ...regime,
            recentSampleCount: regime.recentSampleCountLong!,
            recentMfe: regime.recentMfeLong ?? regime.recentMfe,
            recentMae: regime.recentMaeLong ?? regime.recentMae,
            avgDurationMs: regime.avgDurationLong ?? regime.avgDurationMs,
            // Note: we don't have directional outcome counts yet → fallback to overall
        };
    } else if (direction === 'short' && regime.recentSampleCountShort && regime.recentSampleCountShort >= 2) {
        targetRegime = {
            ...regime,
            recentSampleCount: regime.recentSampleCountShort!,
            recentMfe: regime.recentMfeShort ?? regime.recentMfe,
            recentMae: regime.recentMaeShort ?? regime.recentMae,
            avgDurationMs: regime.avgDurationShort ?? regime.avgDurationMs,
        };
    }

    // ────────────────────────────────────────────────────────────────
    // 3. COMPUTE REGIME SCORE (main scoring logic)
    // ────────────────────────────────────────────────────────────────
    const scoreResult = computeRegimeScore(targetRegime, direction);

    // ────────────────────────────────────────────────────────────────
    // 4. MAP SCORE TO ACTION, CONFIDENCE & MULTIPLIERS
    // ────────────────────────────────────────────────────────────────
    const adviceResult = mapScoreToAdvice(scoreResult, direction);

    // ────────────────────────────────────────────────────────────────
    // 5. BUILD FINAL HUMAN-READABLE ADVICE STRING
    // ────────────────────────────────────────────────────────────────
    const finalAdvice = buildAdviceString(scoreResult, targetRegime, direction);

    // ────────────────────────────────────────────────────────────────
    // 6. RETURN COMPLETE RESULT
    // ────────────────────────────────────────────────────────────────
    return {
        advice: finalAdvice,
        adjustments: adviceResult.adjustments,
        action: adviceResult.action
    };
}


/**
 * Compute overall regime score from recent simulations (weighted average)
 *
 * Core logic (2026+):
 *   1. Selects relevant sims: prefers directional (long/short) if enough samples
 *      Falls back to overall regime data otherwise
 *   2. Scores each individual simulation using cache's computeSimulationScore()
 *   3. Applies exponential weighting:
 *      - Most recent sim gets highest weight (baseWeight)
 *      - Weight decays exponentially for older sims
 *      → Recent performance dominates regime advice
 *   4. Returns weighted average score + breakdown (including directional timing stats)
 *
 * Why exponential weighting?
 *   - Scalping regimes shift quickly — last 1–3 sims are far more predictive
 *   - Prevents old good/bad trades from diluting current signal quality
 *
 * Tunable parameters (hardcoded – move to config later):
 *   - MAX_SIMS           = 10      → max recent sims considered
 *   - minDirectional     = 2       → min directional samples to prefer direction
 *   - baseWeight         = 2.0     → weight of most recent sim
 *   - weightDecay        = 0.8     → each older sim multiplies previous weight
 *
 * Safety features:
 *   - Handles missing/undefined fields gracefully
 *   - Returns safe neutral score if no usable sims
 *   - Clamps final score to 0–5
 *
 * @param regime     Full or lite regime object from cache
 * @param direction  Intended trade direction ('long' | 'short')
 * @returns ExcursionScore with total weighted score + directional timing stats
 */
function computeRegimeScore(
    regime: ExcursionRegime | ExcursionRegimeLite,
    direction: 'long' | 'short'
): ExcursionScore & {
    directionalAvgDurationMs?: number;
    directionalAvgTimeToMFE_ms?: number;
    directionalAvgTimeToMAE_ms?: number;
} {
    // ── 1. Early guard: no data → safe neutral score ───────────────────────
    if (!regime || regime.recentSampleCount <= 0) {
        logger.debug('computeRegimeScore: no samples – returning neutral', {
            symbol: regime?.symbol ?? 'unknown',
            direction,
        });
        return {
            totalScore: 0,
            baseScore: 0,
            timeModifier: 0,
            individualScores: [],
        };
    }

    // ── 2. Select relevant simulations (prefer directional) ─────────────────
    let simsToScore: SimulationHistoryEntry[] = [];
    let isDirectional = false;

    // Prefer directional if enough samples
    if (direction === 'long' && regime.recentSampleCountLong && regime.recentSampleCountLong >= 2) {
        isDirectional = true;
        if ('historyJson' in regime && regime.historyJson) {
            simsToScore = regime.historyJson.filter(e => e.direction === 'buy');
        }
    } else if (direction === 'short' && regime.recentSampleCountShort && regime.recentSampleCountShort >= 2) {
        isDirectional = true;
        if ('historyJson' in regime && regime.historyJson) {
            simsToScore = regime.historyJson.filter(e => e.direction === 'sell');
        }
    }

    // Fallback to overall if no directional or no historyJson
    if (simsToScore.length === 0) {
        isDirectional = false;
        if ('historyJson' in regime && regime.historyJson) {
            simsToScore = regime.historyJson;
        }
    }

    // Limit to most recent MAX_SIMS
    simsToScore = simsToScore.slice(0, MAX_SIMS);

    if (simsToScore.length === 0) {
        logger.debug('computeRegimeScore: no usable sims after filtering – neutral', {
            symbol: regime.symbol,
            direction,
        });
        return {
            totalScore: 0,
            baseScore: 0,
            timeModifier: 0,
            individualScores: [],
        };
    }

    // ── 3. Compute directional timing averages from selected sims ────────────
    let directionalAvgDurationMs = regime.avgDurationMs ?? 0;
    let directionalAvgTimeToMFE_ms = 0;
    let directionalAvgTimeToMAE_ms = 0;

    if (isDirectional && simsToScore.length > 0) {
        // Avg duration from selected directional sims
        directionalAvgDurationMs = simsToScore.reduce((sum, e) => sum + (e.durationMs ?? 0), 0) / simsToScore.length;

        // Avg time-to-MFE (only valid >0 values)
        const validMFE = simsToScore.filter(e => (e.timeToMFE_ms ?? 0) > 0);
        if (validMFE.length > 0) {
            directionalAvgTimeToMFE_ms = validMFE.reduce((sum, e) => sum + (e.timeToMFE_ms ?? 0), 0) / validMFE.length;
        }

        // Avg time-to-MAE
        const validMAE = simsToScore.filter(e => (e.timeToMAE_ms ?? 0) > 0);
        if (validMAE.length > 0) {
            directionalAvgTimeToMAE_ms = validMAE.reduce((sum, e) => sum + (e.timeToMAE_ms ?? 0), 0) / validMAE.length;
        }
    }

    // ── 4. Score each simulation using cache method + collect raw scores ─────
    const individualScores: number[] = [];
    let sumWeightedScore = 0;
    let sumWeights = 0;

    const baseWeight = 2.0;
    const weightDecay = 0.8;
    let currentWeight = baseWeight;

    for (const entry of simsToScore) {
        const { totalScore } = excursionCache.computeSimulationScore(entry);
        individualScores.push(totalScore);

        sumWeightedScore += totalScore * currentWeight;
        sumWeights += currentWeight;

        currentWeight *= weightDecay; // exponential decay
    }

    // ── 5. Final weighted average score ─────────────────────────────────────
    const totalScore = sumWeights > 0 ? sumWeightedScore / sumWeights : 0;
    const clampedScore = Math.max(0, Math.min(5, totalScore));

    // ── 6. Build enriched result ────────────────────────────────────────────
    const result: ExcursionScore & {
        directionalAvgDurationMs?: number;
        directionalAvgTimeToMFE_ms?: number;
        directionalAvgTimeToMAE_ms?: number;
    } = {
        totalScore: clampedScore,
        baseScore: totalScore, // for compatibility
        timeModifier: 0,       // not used at aggregate level
        individualScores,
    };

    // Add directional timing stats (useful for advice/alerts)
    if (directionalAvgDurationMs > 0) {
        result.directionalAvgDurationMs = directionalAvgDurationMs;
    }
    if (directionalAvgTimeToMFE_ms > 0) {
        result.directionalAvgTimeToMFE_ms = directionalAvgTimeToMFE_ms;
    }
    if (directionalAvgTimeToMAE_ms > 0) {
        result.directionalAvgTimeToMAE_ms = directionalAvgTimeToMAE_ms;
    }

    // Optional debug logging (uncomment during tuning)
    logger.debug('Computed regime score', {
        symbol: regime.symbol,
        direction,
        isDirectional,
        simCount: simsToScore.length,
        totalScore: clampedScore.toFixed(2),
        individualScores: individualScores.map(s => s.toFixed(2)),
        directionalAvgDurationMin: directionalAvgDurationMs ? (directionalAvgDurationMs / 60000).toFixed(1) : 'n/a',
    });

    return result;
}

/**
 * Map final regime score to trading action & adjustments
 *
 * This function translates the aggregated regime score into a concrete trading decision.
 * It uses fixed but clearly documented thresholds to make the logic:
 *   - Transparent and easy to tune
 *   - Explainable (why did we take/reverse/skip?)
 *   - Conservative by default (prefers skip over aggressive reverse)
 *
 * Updated reverse sensitivity:
 *   - Reverse triggers on finalScore ≤ 1.4
 *   - AND at least 3 of the most recent 5 sims have score ≤ 1.5 (consistent recent bad performance)
 *   - This captures MAE-dominant timeouts or fast clean losses more reliably
 *   - Still conservative: requires clear recent adverse pattern
 *
 * Score interpretation guide (2025 scalping defaults):
 *   ≥ 3.8     → strong take     (very high conviction – widen TP, boost confidence)
 *   3.0–3.79  → take           (solid edge – normal size, mild boost)
 *   2.0–2.99  → cautious take  (acceptable but reduce risk – tighten SL)
 *   1.0–1.99  → skip / minimal (weak signal – very small size or skip)
 *   ≤ 1.4     → reverse if recent sims consistently bad, else skip
 *
 * Tunable thresholds (hardcoded for now – extract to config.strategy later):
 *   STRONG_TAKE_THRESHOLD   = 3.8
 *   TAKE_THRESHOLD          = 3.0
 *   CAUTIOUS_THRESHOLD      = 2.0
 *   REVERSE_SCORE_THRESHOLD = 1.4
 *   REVERSE_BAD_SIM_THRESHOLD = 1.5  // individual sim score considered "bad"
 *   REVERSE_RECENT_COUNT      = 5    // look at most recent N sims
 *   REVERSE_MIN_BAD           = 3    // need at least this many bad recent sims
 *
 * Safety principles:
 *   - Never returns extreme multipliers (clamped)
 *   - Prefers 'skip' over aggressive 'reverse' when borderline
 *   - Returns base advice string for further embellishment in buildAdviceString
 *
 * @param score      - Result from computeRegimeScore (totalScore + breakdown)
 * @param _direction - Intended trade direction (unused for now – kept for future)
 * @returns ExcursionAdvice with action, adjustments, and base advice string
 */
function mapScoreToAdvice(
    score: ExcursionScore,
    _direction: 'long' | 'short'
): ExcursionAdvice {
    // ────────────────────────────────────────────────────────────────
    // 1. EARLY GUARD – invalid/zero score → safest possible response
    // ────────────────────────────────────────────────────────────────
    if (!score || typeof score.totalScore !== 'number') {
        logger.warn('mapScoreToAdvice received invalid score – returning skip', { score });
        return {
            advice: '⚪ Invalid regime score – holding (safety)',
            adjustments: {
                slMultiplier: 1.0,
                tpMultiplier: 1.0,
                confidenceBoost: -0.30,
            },
            action: 'skip'
        };
    }

    logger.error('mapScoreToAdvice received score', {
        totalScore: score.totalScore,
        baseScore: score.baseScore,
        timeModifier: score.timeModifier,
        individualScoresCount: score.individualScores.length,
        individualScores: score.individualScores.map(s => s.toFixed(2)),
    });

    const finalScore = score.totalScore;

    // ────────────────────────────────────────────────────────────────
    // 2. DEFINE THRESHOLDS & ADJUSTMENT MAPPINGS
    // ────────────────────────────────────────────────────────────────
    const STRONG_TAKE_THRESHOLD = 3.8;
    const TAKE_THRESHOLD = 2.5;
    const CAUTIOUS_THRESHOLD = 2.0;
    const REVERSE_SCORE_THRESHOLD = 1.4;
    const REVERSE_BAD_SIM_THRESHOLD = 1.5; // individual sim ≤ this = "bad"
    const REVERSE_RECENT_COUNT = 5;
    const REVERSE_MIN_BAD = 3; // need at least this many bad recent sims

    let action: ExcursionAction = 'skip';
    let baseAdvice = '';
    let slMult = 1.0;
    let tpMult = 1.0;
    let confBoost = 0.0;

    // ────────────────────────────────────────────────────────────────
    // 3. DECISION TREE – map score ranges to action & adjustments
    // ────────────────────────────────────────────────────────────────
    if (finalScore >= STRONG_TAKE_THRESHOLD) {
        action = 'take';
        baseAdvice = `🟢 Strong regime (${finalScore.toFixed(2)}) – high conviction take`;
        slMult = 1.10;
        tpMult = 1.40;
        confBoost = 0.30;

    } else if (finalScore >= TAKE_THRESHOLD) {
        action = 'take';
        baseAdvice = `🟢 Good regime (${finalScore.toFixed(2)}) – take`;
        slMult = 1.00;
        tpMult = 1.25;
        confBoost = 0.15;

    } else if (finalScore >= CAUTIOUS_THRESHOLD) {
        action = 'take';
        baseAdvice = `🟠 Cautious regime (${finalScore.toFixed(2)}) – take small/reduced`;
        slMult = 0.85;
        tpMult = 1.10;
        confBoost = -0.05;

    } else {
        // Weak to bad regime — decide between skip and reverse
        // Check recent individual sims for consistent bad performance
        const recentSims = score.individualScores.slice(0, REVERSE_RECENT_COUNT);
        const badRecentCount = recentSims.filter(s => s <= REVERSE_BAD_SIM_THRESHOLD).length;

        const shouldReverse = finalScore <= REVERSE_SCORE_THRESHOLD && badRecentCount >= REVERSE_MIN_BAD;

        if (shouldReverse) {
            action = 'reverse';
            baseAdvice = `🔴 Adverse regime (${finalScore.toFixed(2)}) – reverse (${badRecentCount}/${recentSims.length} recent bad sims)`;
            slMult = 0.70;
            tpMult = 1.30;
            confBoost = -0.10;
        } else {
            action = 'skip';
            baseAdvice = `🟡 Weak regime (${finalScore.toFixed(2)}) – skip`;
            slMult = 0.75;
            tpMult = 0.90;
            confBoost = -0.20;
        }
    }

    // ────────────────────────────────────────────────────────────────
    // 4. FINAL SAFETY CLAMP – prevent extreme multipliers
    // ────────────────────────────────────────────────────────────────
    slMult = Math.max(0.50, Math.min(1.50, slMult));
    tpMult = Math.max(0.70, Math.min(1.60, tpMult));
    confBoost = Math.max(-0.40, Math.min(0.40, confBoost));

    // ────────────────────────────────────────────────────────────────
    // 5. RETURN COMPLETE RESULT
    // ────────────────────────────────────────────────────────────────
    return {
        advice: baseAdvice,
        adjustments: {
            slMultiplier: slMult,
            tpMultiplier: tpMult,
            confidenceBoost: confBoost,
        },
        action
    };
}

/**
 * Build human-readable advice string with emojis and warnings
 *
 * This function creates the final user-facing advice text that appears in:
 *   - Strategy logs
 *   - AutoTrade decisions
 *   - Telegram alerts / UI
 *   - Debugging output
 *
 * Goals:
 *   - Be concise yet informative (fits in logs/alerts without truncation)
 *   - Use clear emojis for instant visual signal strength
 *   - Include key drivers (score, duration, MFE/MAE, outcome summary)
 *   - Highlight warnings/risks when present
 *   - Be directional-aware (long/short context)
 *
 * Structure of final string:
 *   [Emoji] [Main verdict] ([score]) – [positive drivers] | [warnings if any]
 *
 * Emoji guide:
 *   🟢 = strong take / good regime
 *   🟡 = neutral / cautious
 *   🟠 = risky but possible
 *   🔴 = bad regime / reverse / strong skip
 *   ⚠️ = warning prefix
 *   ⚡ / 🚀 = fast momentum / quick wins
 *
 * New additions:
 *   - Directional timing stats (avg duration, time-to-MFE/MAE) when available
 *   - More nuanced warnings and drivers
 *
 * @param score     - Computed regime score + breakdown (may include directional timing)
 * @param regime    - Regime data (for outcome counts, duration, MFE/MAE)
 * @param direction - Trade direction ('long' | 'short')
 * @returns Final human-readable advice string
 */
function buildAdviceString(
    score: ExcursionScore,
    regime: ExcursionRegime | ExcursionRegimeLite,
    direction: 'long' | 'short'
): string {
    // ────────────────────────────────────────────────────────────────
    // 1. EARLY GUARD – invalid score → safe fallback message
    // ────────────────────────────────────────────────────────────────
    if (!score || typeof score.totalScore !== 'number') {
        return '⚪ Invalid regime score – holding (safety)';
    }

    const finalScore = score.totalScore;

    // ────────────────────────────────────────────────────────────────
    // 2. DETERMINE MAIN EMOJI & VERDICT BASED ON SCORE
    // ────────────────────────────────────────────────────────────────
    let emoji = '⚪';
    let verdict = 'Neutral regime';

    if (finalScore >= 3.8) {
        emoji = '🟢';
        verdict = 'Strong regime';
    } else if (finalScore >= 3.0) {
        emoji = '🟢';
        verdict = 'Good regime';
    } else if (finalScore >= 2.0) {
        emoji = '🟠';
        verdict = 'Cautious regime';
    } else if (finalScore >= 1.0) {
        emoji = '🟡';
        verdict = 'Weak regime';
    } else {
        emoji = '🔴';
        verdict = 'Bad regime';
    }

    // ────────────────────────────────────────────────────────────────
    // 3. BUILD CORE ADVICE – score + verdict
    // ────────────────────────────────────────────────────────────────
    let advice = `${emoji} ${verdict} (${finalScore.toFixed(1)})`;

    // ────────────────────────────────────────────────────────────────
    // 4. ADD POSITIVE / NEGATIVE DRIVERS
    // ────────────────────────────────────────────────────────────────
    const drivers: string[] = [];

    // 4.1 Overall duration insight
    const avgDurationMin = regime.avgDurationMs ? (regime.avgDurationMs / 60000).toFixed(1) : null;
    if (avgDurationMin) {
        if (Number(avgDurationMin) <= 4) {
            drivers.push(`⚡ fast (${avgDurationMin} min avg)`);
        } else if (Number(avgDurationMin) >= 7) {
            drivers.push(`🐢 slow (${avgDurationMin} min avg)`);
        } else {
            drivers.push(`duration ${avgDurationMin} min`);
        }
    }

    // Directional duration if available (from computeRegimeScore enhancement)
    // if (score.directionalAvgDurationMs) {
    //     const dirMin = ((score as any).directionalAvgDurationMs / 60000).toFixed(1);
    //     drivers.push(`dir avg ${dirMin} min`);
    // }

    // 4.2 MFE/MAE summary
    const mfe = regime.recentMfe ?? 0;
    const absMae = Math.abs(regime.recentMae ?? 0);
    if (mfe >= 2.0) {
        drivers.push(`strong MFE (+${mfe.toFixed(1)}%)`);
    } else if (mfe >= 0.5) {
        drivers.push(`decent MFE (+${mfe.toFixed(1)}%)`);
    }

    if (absMae >= 2.0) {
        drivers.push(`high MAE (-${absMae.toFixed(1)}%)`);
    }

    // 4.3 Outcome summary
    const oc = regime.outcomeCounts ?? { tp: 0, partial_tp: 0, sl: 0, timeout: 0 };
    const totalOutcomes = oc.tp + oc.partial_tp + oc.sl + oc.timeout;
    if (totalOutcomes >= 3) {
        const tpPct = ((oc.tp + oc.partial_tp) / totalOutcomes * 100).toFixed(0);
        const slPct = (oc.sl / totalOutcomes * 100).toFixed(0);
        drivers.push(`${tpPct}% wins / ${slPct}% SL`);
    }

    // Add drivers
    if (drivers.length > 0) {
        advice += ` – ${drivers.join(' + ')}`;
    }

    // ────────────────────────────────────────────────────────────────
    // 5. DIRECTIONAL CONTEXT
    // ────────────────────────────────────────────────────────────────
    advice += direction === 'long' ? ` (long bias)` : ` (short bias)`;

    // ────────────────────────────────────────────────────────────────
    // 6. WARNINGS
    // ────────────────────────────────────────────────────────────────
    const warnings: string[] = [];

    if (absMae >= 2.5) warnings.push(`high drawdown (-${absMae.toFixed(1)}%)`);
    if (avgDurationMin && Number(avgDurationMin) > 7) warnings.push(`slow closure`);
    if (regime.slStreak >= 2) warnings.push(`SL streak: ${regime.slStreak}`);
    if (regime.timeoutRatio > 0.5) warnings.push(`high timeouts`);

    // Directional timing warnings
    if ((score as any).directionalAvgTimeToMFE_ms > 0) {
        const sec = ((score as any).directionalAvgTimeToMFE_ms / 1000).toFixed(0);
        if (Number(sec) > 180) warnings.push(`late MFE peak (${sec}s)`);
    }

    if ((score as any).directionalAvgTimeToMAE_ms > 0) {
        const sec = ((score as any).directionalAvgTimeToMAE_ms / 1000).toFixed(0);
        if (Number(sec) <= 60 && absMae >= 1.0) warnings.push(`rapid meaningful drawdown (${sec}s)`);
    }

    if (warnings.length > 0) {
        advice += ` | ⚠️ ${warnings.join(' | ')}`;
    }

    // ────────────────────────────────────────────────────────────────
    // 7. ACTION IMPLICATION
    // ────────────────────────────────────────────────────────────────
    if (finalScore >= 3.8) {
        advice += ` → strong take`;
    } else if (finalScore <= 1.4) {
        advice += ` → skip or reverse`;
    } else if (finalScore >= 3.0) {
        advice += ` → take`;
    } else {
        advice += ` → hold`;
    }

    return advice;
}
