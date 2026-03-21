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
 *
 * - 'take'   → Proceed with original direction (buy → long, sell → short)
 * - 'reverse'→ Flip direction (buy → sell, sell → buy) — only if intended side has enough data
 * - 'skip'   → Do not trade/alert — insufficient data, poor regime, or high risk
 */
export type ExcursionAction = 'take' | 'reverse' | 'skip';

/**
 * Result of excursion regime analysis
 *
 * Returned by getExcursionAdvice() — the main decision output for:
 *   - AutoTradeService (final gatekeeper)
 *   - Strategy.generateSignal() (confidence & level adjustments)
 *   - Telegram alerts (human-readable summary)
 *
 * Key principles in 2026 directional version:
 *   - Action is based **primarily on intended direction's aggregates** (regime.buy or regime.sell)
 *   - Requires ≥3 samples on intended side for 'take' or 'reverse'
 *   - 'skip' is forced if intended side < 3 samples (even if combined ≥3)
 *   - Adjustments are directional (applied to the final side after possible reversal)
 *   - advice string is rich & directional-aware (shows both sides if data exists)
 */
export interface ExcursionAdvice {
    /**
     * Human-readable summary with emojis, verdict, drivers, warnings
     * Multi-line capable — suitable for Telegram / logs
     * Example:
     *   🟢 Good regime (3.6) – fast • strong MFE
     *   Long: +1.8% MFE / -0.9% MAE
     *   Short: +0.7% MFE / -2.1% MAE
     *   → take
     */
    advice: string;

    /**
     * Multipliers & boosts to apply to the final trade (after possible reversal)
     * - slMultiplier: applied to stop-loss distance (e.g. 0.9 = tighten by 10%)
     * - tpMultiplier: applied to all take-profit levels (e.g. 1.2 = widen by 20%)
     * - confidenceBoost: added to final signal confidence (range usually -0.4 to +0.4)
     */
    adjustments: {
        slMultiplier: number;
        tpMultiplier: number;
        confidenceBoost: number;
    };

    /**
     * Core decision:
     * - 'take'    → execute in original or reversed direction
     * - 'reverse' → flip side (only possible if intended side has ≥3 samples)
     * - 'skip'    → no trade/alert (insufficient side samples or poor regime)
     */
    action: ExcursionAction;

    score: number; // Added score to the interface for better integration with AutoTradeService
}

/**
 * Result of regime scoring (used internally by getExcursionAdvice)
 *
 * Contains the final weighted score + breakdown components
 * Can include directional timing/score details when computed per side
 */
export interface ExcursionScore {
    /** Final weighted score (0–5 scale) — main driver of action/adjustments */
    totalScore: number;

    /** Average base score from individual recent simulations */
    baseScore: number;

    /** Time-based modifier (rewards fast good moves, penalizes slow/sloppy) */
    timeModifier: number;

    /** Optional: trend modifier (e.g. improving/worsening recent scores) */
    trendModifier?: number;

    /** Raw base scores per recent simulation (for debugging / weighting analysis) */
    individualScores: number[];

    // ── Optional directional breakdown (added when scoring one side specifically) ──
    /** If computed directionally: average duration of that side's simulations */
    directionalAvgDurationMs?: number;

    /** If available: average time-to-peak MFE on this side */
    directionalAvgTimeToMFE_ms?: number;

    /** If available: average time-to-max MAE on this side */
    directionalAvgTimeToMAE_ms?: number;
}


// ==============================================================================
// CONSTANTS
// =============================================================================
const MAX_SIMS = 10; // Maximum number of recent sims to consider

/**
 * Analyze recent regime and return actionable advice + adjustments
 *
 * Core 2026 directional logic – side-specific regime evaluation for scalping:
 *
 * 1. Combined total samples check (recentSampleCount >= 3) → proceed or early skip
 *    (this gates whether we even consider alerting/trading)
 *
 * 2. Intended direction sample check (buy or sell side >= 3) → strict requirement
 *    - If < 3 on intended side → force 'skip' (conservative, no guessing)
 *    - Reversal only possible if intended side has enough data to trust its weakness
 *
 * 3. Use **only the intended side's aggregates** (regime.buy or regime.sell)
 *    for scoring, adjustments, and advice generation
 *    - No fallback to combined or opposite side — pure directional
 *
 * 4. Compute weighted regime score (0–5) from recent simulations on that side
 *    - Rewards strong wins, fast good moves, timeouts with high MFE
 *    - Penalizes clean SLs, slow/bad moves
 *
 * 5. Map score to explicit action ('take' / 'reverse' / 'skip')
 *    and multipliers (SL/TP/confidence)
 *
 * 6. Build rich, directional-aware human-readable advice string
 *    (shows both sides if data exists, highlights intended direction)
 *
 * Tunable parameters (move to config later):
 * - MIN_SIDE_SAMPLES = 3 (hard requirement for take/reverse)
 * - MIN_COMBINED_FOR_ALERT = 3 (gate for even sending alert)
 * - Scoring weights, MFE/MAE thresholds, duration bands, etc.
 *
 * @param regime Full or lite ExcursionRegime from cache (with buy/sell nested objects)
 * @param direction Intended direction ('long' = buy, 'short' = sell)
 * @returns ExcursionAdvice with action, adjustments, and readable multi-line advice
 */
export function getExcursionAdvice(
    regime: ExcursionRegime | ExcursionRegimeLite | null | undefined,
    direction: 'long' | 'short'
): ExcursionAdvice {
    // ────────────────────────────────────────────────────────────────
    // 1. EARLY GUARD: Invalid/missing regime → immediate skip
    // ────────────────────────────────────────────────────────────────
    if (!regime || typeof regime !== 'object') {
        logger.debug('getExcursionAdvice: invalid or missing regime – forced skip', {
            direction,
            regimeType: regime === null ? 'null' : typeof regime
        });

        return {
            advice: '⚪ No regime data available – holding (safety)',
            adjustments: {
                slMultiplier: 1.0,
                tpMultiplier: 1.0,
                confidenceBoost: -0.30
            },
            action: 'skip',
            score: 0 // Added score for consistency, even in skip cases
        };
    }

    // ────────────────────────────────────────────────────────────────
    // 2. CHECK COMBINED SAMPLES – gate for any alert/trade consideration
    //    (≥ 3 total simulations → worth evaluating, even if one side weak)
    // ────────────────────────────────────────────────────────────────
    const combinedCount = regime.recentSampleCount ?? 0;

    if (combinedCount < 3) {
        return {
            advice: `⚠️ Too few total simulations (${combinedCount}/3) – no alert/trade`,
            adjustments: {
                slMultiplier: 1.0,
                tpMultiplier: 1.0,
                confidenceBoost: -0.40
            },
            action: 'skip',
            score: 0
        };
    }

    // ────────────────────────────────────────────────────────────────
    // 3. CHECK INTENDED SIDE SAMPLES – strict requirement for decision
    //    < 3 on this side → skip (no take, no reverse)
    // ────────────────────────────────────────────────────────────────
    const isLong = direction === 'long';
    const sideAgg = isLong ? regime.buy : regime.sell;
    const sideCount = sideAgg?.sampleCount ?? 0;

    // Use updated hasEnoughSamples with direction parameter (pure directional)
    const sideHasEnough = ExcursionHistoryCache.hasEnoughSamples(regime, 3, direction);

    if (!sideHasEnough) {
        logger.info('getExcursionAdvice: insufficient samples on intended side – forced skip', {
            symbol: regime.symbol,
            direction,
            sideCount,
            combinedCount,
            required: 3
        });

        return {
            advice: `⚠️ Too few ${direction} simulations (${sideCount}/3) – holding`,
            adjustments: {
                slMultiplier: 1.0,
                tpMultiplier: 1.0,
                confidenceBoost: -0.35 // stronger penalty than combined-only
            },
            action: 'skip',
            score: 0
        };
    }

    // ────────────────────────────────────────────────────────────────
    // 4. SELECT SIDE-SPECIFIC AGGREGATES FOR SCORING & ADVICE
    //    (we now trust this side – use its MFE/MAE/duration/outcomes only)
    // ────────────────────────────────────────────────────────────────
    if (!sideAgg) {
        // Rare edge case: hasEnoughSamples said yes, but agg missing → force skip (pure – no fallback)
        logger.warn('Side has enough samples but aggregates missing – forced skip', {
            symbol: regime.symbol,
            direction,
            sideCount
        });
        return {
            advice: `⚠️ Directional aggregates missing – holding (safety)`,
            adjustments: {
                slMultiplier: 1.0,
                tpMultiplier: 1.0,
                confidenceBoost: -0.30
            },
            action: 'skip',
            score: 0
        };
    }

    // ────────────────────────────────────────────────────────────────
    // 5. COMPUTE REGIME SCORE USING SIDE-SPECIFIC DATA
    // ────────────────────────────────────────────────────────────────
    const scoreResult = computeRegimeScore(regime, direction); // Note: computeRegimeScore accepts DirectionalAggregates

    // ────────────────────────────────────────────────────────────────
    // 6. MAP SCORE TO ACTION + ADJUSTMENTS
    // ────────────────────────────────────────────────────────────────
    const adviceResult = mapScoreToAdvice(scoreResult, direction);

    // ────────────────────────────────────────────────────────────────
    // 7. BUILD FINAL HUMAN-READABLE ADVICE STRING
    //    (now directional-aware, shows both sides if data exists)
    // ────────────────────────────────────────────────────────────────
    const finalAdvice = buildAdviceString(scoreResult, regime, direction);

    // ────────────────────────────────────────────────────────────────
    // 8. RETURN COMPLETE RESULT
    // ────────────────────────────────────────────────────────────────
    logger.debug('getExcursionAdvice completed', {
        symbol: regime.symbol,
        direction,
        sideSamples: sideCount,
        totalSamples: combinedCount,
        finalScore: scoreResult.totalScore.toFixed(2),
        action: adviceResult.action,
        advicePreview: finalAdvice.substring(0, 100) + (finalAdvice.length > 100 ? '...' : '')
    });

    return {
        advice: finalAdvice,
        adjustments: adviceResult.adjustments,
        action: adviceResult.action,
        score: scoreResult.totalScore // Pass the computed score for better integration with AutoTradeService
    };
}


/**
 * Compute regime score from recent simulations (weighted average) – **pure directional only**
 *
 * Core logic (2026+ strict directional version):
 *   - Uses **only** simulations from the intended direction ('buy' or 'sell')
 *   - Requires ≥3 samples on that side (checked upstream in getExcursionAdvice)
 *   - No fallback to combined, opposite side, or any mixed data — pure isolation
 *   - If insufficient sims or missing data → returns neutral score (0)
 *
 * Why pure directional?
 *   - Long/short regimes often behave very differently — mixing them dilutes signal
 *   - Decisions must be based exclusively on the intended side's history
 *   - Upstream (getExcursionAdvice) already forces 'skip' if side < 3 samples
 *
 * Exponential weighting:
 *   - Most recent sims dominate (scalping regimes shift fast)
 *   - Prevents old trades from overpowering current side signal
 *
 * Tunable parameters (hardcoded – move to config later):
 *   - MAX_SIMS           = 10     → max recent sims considered
 *   - baseWeight         = 2.0    → weight of most recent sim
 *   - weightDecay        = 0.8    → exponential decay factor
 *
 * Safety features:
 *   - Handles missing historyJson, empty sims, or undefined fields → neutral score
 *   - Clamps final score to 0–5
 *   - Defensive logging for debugging side data issues
 *
 * @param regime Full or lite ExcursionRegime from cache
 * @param direction Intended direction ('long' = buy, 'short' = sell)
 * @returns ExcursionScore with weighted total + directional timing stats
 */
function computeRegimeScore(
    regime: ExcursionRegime,
    direction: 'long' | 'short'
): ExcursionScore & {
    directionalAvgDurationMs?: number;
    directionalAvgTimeToMFE_ms?: number;
    directionalAvgTimeToMAE_ms?: number;
} {
    // ── 1. Early guard: invalid/missing regime → neutral score ───────────────────────
    if (!regime || typeof regime !== 'object') {
        logger.debug('computeRegimeScore: invalid/missing regime – neutral score', {
            direction
        });
        return {
            totalScore: 0,
            baseScore: 0,
            timeModifier: 0,
            individualScores: [],
        };
    }

    // ── 2. Strict directional selection – only this side, no fallback ───────────────
    const MIN_SIDE_SAMPLES = 3;  // Must match getExcursionAdvice requirement
    const isLong = direction === 'long';
    const sideDirection = isLong ? 'buy' : 'sell';

    // Quick side sample check (upstream already did hasEnoughSamples, but defensive)
    const sideCount = isLong ? regime.buy?.sampleCount ?? 0 : regime.sell?.sampleCount ?? 0;

    if (sideCount < MIN_SIDE_SAMPLES) {
        logger.debug('computeRegimeScore: insufficient side samples – neutral score', {
            symbol: regime.symbol,
            direction,
            sideSamples: sideCount,
            minRequired: MIN_SIDE_SAMPLES
        });
        return {
            totalScore: 0,
            baseScore: 0,
            timeModifier: 0,
            individualScores: [],
        };
    }

    // ── 3. Filter simulations to **only** this direction ─────────────────────────────
    let simsToScore: SimulationHistoryEntry[] = [];

    if ('historyJson' in regime && regime.historyJson) {
        simsToScore = regime.historyJson.filter(e => e.direction === sideDirection);
    }

    // Cap to most recent MAX_SIMS
    simsToScore = simsToScore.slice(0, MAX_SIMS);

    if (simsToScore.length === 0) {
        logger.warn('computeRegimeScore: no matching sims for direction despite sampleCount ≥3 – neutral', {
            symbol: regime.symbol,
            direction,
            sideCount,
            historyJsonLength: regime.historyJson?.length ?? 0
        });
        return {
            totalScore: 0,
            baseScore: 0,
            timeModifier: 0,
            individualScores: [],
        };
    }

    // ── 4. Compute directional timing averages from filtered side sims ────────────────
    let directionalAvgDurationMs = 0;
    let directionalAvgTimeToMFE_ms = 0;
    let directionalAvgTimeToMAE_ms = 0;

    if (simsToScore.length > 0) {
        // Avg duration from this side only
        directionalAvgDurationMs = simsToScore.reduce((sum, e) => sum + (e.durationMs ?? 0), 0) / simsToScore.length;

        // Avg time-to-MFE (only valid positive values)
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

    // ── 5. Score each simulation + collect weighted average ──────────────────────────
    const individualScores: number[] = [];
    let sumWeightedScore = 0;
    let sumWeights = 0;

    const baseWeight = 2.0;      // most recent sim gets 2.0×
    const weightDecay = 0.8;     // each older sim ×0.8
    let currentWeight = baseWeight;

    for (const entry of simsToScore) {
        const { totalScore } = excursionCache.computeSimulationScore(entry);
        individualScores.push(totalScore);

        sumWeightedScore += totalScore * currentWeight;
        sumWeights += currentWeight;

        currentWeight *= weightDecay; // decay for next (older) sim
    }

    // ── 6. Final weighted score + clamp to 0–5 ──────────────────────────────────────
    const totalScore = sumWeights > 0 ? sumWeightedScore / sumWeights : 0;
    const clampedScore = Math.max(0, Math.min(5, totalScore));

    // ── 7. Build enriched result with directional timing ─────────────────────────────
    const result: ExcursionScore & {
        directionalAvgDurationMs?: number;
        directionalAvgTimeToMFE_ms?: number;
        directionalAvgTimeToMAE_ms?: number;
    } = {
        totalScore: clampedScore,
        baseScore: totalScore, // for compatibility
        timeModifier: 0,       // aggregate level – individual sims already timed
        individualScores,
    };

    // Attach directional timing stats (used in buildAdviceString)
    if (directionalAvgDurationMs > 0) {
        result.directionalAvgDurationMs = directionalAvgDurationMs;
    }
    if (directionalAvgTimeToMFE_ms > 0) {
        result.directionalAvgTimeToMFE_ms = directionalAvgTimeToMFE_ms;
    }
    if (directionalAvgTimeToMAE_ms > 0) {
        result.directionalAvgTimeToMAE_ms = directionalAvgTimeToMAE_ms;
    }

    // ── 8. Debug logging (pure directional confirmation) ─────────────────────────────
    logger.debug('Computed regime score (pure directional)', {
        symbol: regime.symbol ?? 'unknown',
        direction,
        simCount: simsToScore.length,
        totalScore: clampedScore.toFixed(2),
        individualScores: individualScores.map(s => s.toFixed(2)),
        directionalAvgDurationMin: directionalAvgDurationMs ? (directionalAvgDurationMs / 60000).toFixed(1) : 'n/a',
        directionalAvgTimeToMFE_s: directionalAvgTimeToMFE_ms ? (directionalAvgTimeToMFE_ms / 1000).toFixed(0) : 'n/a',
        directionalAvgTimeToMAE_s: directionalAvgTimeToMAE_ms ? (directionalAvgTimeToMAE_ms / 1000).toFixed(0) : 'n/a'
    });

    // ── 9. Return final result ───────────────────────────────────────────────────────
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
 * 2026+ pure directional rules:
 *   - Score is already computed from **only the intended side** (buy or sell)
 *   - Reversal requires:
 *     - Very low final score (≤ 1.4)
 *     - Consistent recent bad performance on this side (≥3 bad sims in last 5)
 *   - No combined or opposite-side data used — pure side isolation
 *   - Adjustments are applied to the final side (after possible reverse)
 *
 * Score interpretation guide (scalping defaults – tunable):
 *   ≥ 3.8     → strong take     (high conviction – widen TP, boost confidence)
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
 *   REVERSE_BAD_SIM_THRESHOLD = 1.5   // individual sim score considered "bad"
 *   REVERSE_RECENT_COUNT      = 5     // look at most recent N sims
 *   REVERSE_MIN_BAD           = 3     // need at least this many bad recent sims
 *
 * Safety principles:
 *   - Never returns extreme multipliers (clamped)
 *   - Prefers 'skip' over aggressive 'reverse' when borderline
 *   - Returns base advice string for further embellishment in buildAdviceString
 *
 * @param score      - Result from computeRegimeScore (pure directional, side-specific)
 * @param direction  - Intended trade direction (used for context/logging only)
 * @returns ExcursionAdvice with action, adjustments, and base advice string
 */
function mapScoreToAdvice(
    score: ExcursionScore,
    direction: 'long' | 'short'
): ExcursionAdvice {
    // ────────────────────────────────────────────────────────────────
    // 1. EARLY GUARD – invalid/zero score → safest possible response
    // ────────────────────────────────────────────────────────────────
    if (!score || typeof score.totalScore !== 'number') {
        logger.warn('mapScoreToAdvice received invalid score – returning skip', {
            direction,
            scoreProvided: !!score
        });

        return {
            advice: '⚪ Invalid regime score – holding (safety)',
            adjustments: {
                slMultiplier: 1.0,
                tpMultiplier: 1.0,
                confidenceBoost: -0.30,
            },
            action: 'skip',
            score: 0
        };
    }

    const finalScore = score.totalScore;

    // ────────────────────────────────────────────────────────────────
    // 2. DEFINE THRESHOLDS & ADJUSTMENT MAPPINGS
    //    All hardcoded for now – extract to config later
    // ────────────────────────────────────────────────────────────────
    const STRONG_TAKE_THRESHOLD = 3.8;
    const TAKE_THRESHOLD = 3.0;
    const CAUTIOUS_THRESHOLD = 2.0;
    const REVERSE_SCORE_THRESHOLD = 1.4;
    const REVERSE_BAD_SIM_THRESHOLD = 1.5; // individual sim ≤ this = "bad"
    const REVERSE_RECENT_COUNT = 5;
    const REVERSE_MIN_BAD = 3;     // need at least this many bad recent sims

    let action: ExcursionAction = 'skip';
    let baseAdvice = '';
    let slMult = 1.0;
    let tpMult = 1.0;
    let confBoost = 0.0;

    // ────────────────────────────────────────────────────────────────
    // 3. DECISION TREE – map score ranges to action & adjustments
    //    Pure directional: score already comes from one side only
    // ────────────────────────────────────────────────────────────────
    if (finalScore >= STRONG_TAKE_THRESHOLD) {
        action = 'take';
        baseAdvice = `🟢 Strong regime (${finalScore.toFixed(2)}) – high conviction take`;
        slMult = 1.10;    // slight widen SL (more room)
        tpMult = 1.40;    // significantly widen TP
        confBoost = 0.30; // strong confidence boost

    } else if (finalScore >= TAKE_THRESHOLD) {
        action = 'take';
        baseAdvice = `🟢 Good regime (${finalScore.toFixed(2)}) – take`;
        slMult = 1.00;    // neutral SL
        tpMult = 1.25;    // moderate TP expansion
        confBoost = 0.15; // mild boost

    } else if (finalScore >= CAUTIOUS_THRESHOLD) {
        action = 'take';
        baseAdvice = `🟠 Cautious regime (${finalScore.toFixed(2)}) – take small/reduced`;
        slMult = 0.85;    // tighten SL (reduce risk)
        tpMult = 1.10;    // slight TP widen
        confBoost = -0.05; // slight penalty

    } else {
        // Weak to bad regime — decide between skip and reverse
        // Check recent individual sims for consistent bad performance on this side
        const recentSims = score.individualScores.slice(0, REVERSE_RECENT_COUNT);
        const badRecentCount = recentSims.filter(s => s <= REVERSE_BAD_SIM_THRESHOLD).length;

        const shouldReverse = finalScore <= REVERSE_SCORE_THRESHOLD && badRecentCount >= REVERSE_MIN_BAD;

        if (shouldReverse) {
            action = 'reverse';
            baseAdvice = `🔴 Adverse regime (${finalScore.toFixed(2)}) – reverse (${badRecentCount}/${recentSims.length} recent bad sims)`;
            slMult = 0.70;    // tighten SL on reversal
            tpMult = 1.30;    // widen TP on reversal
            confBoost = -0.10; // penalty for reversing
        } else {
            action = 'skip';
            baseAdvice = `🟡 Weak regime (${finalScore.toFixed(2)}) – skip`;
            slMult = 0.75;    // tighten SL on weak signal
            tpMult = 0.90;    // reduce TP exposure
            confBoost = -0.20; // stronger penalty
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
        action,
        score: finalScore
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
 * Goals (pure directional 2026+):
 *   - Be concise yet informative (fits in logs/alerts without truncation)
 *   - Use clear emojis for instant visual signal strength
 *   - Include key drivers (score, duration, MFE/MAE, outcome summary) from **intended side only**
 *   - Show **both buy and sell sides** when data exists (for transparency)
 *   - Highlight primary (intended) direction first
 *   - Highlight warnings/risks from the intended side
 *   - No combined aggregates used — pure directional isolation
 *
 * Structure of final string (multi-line Telegram-friendly):
 *   🟢 Good regime (3.6) – strong MFE + fast closure
 *   Long side: +1.8% MFE / -0.9% MAE • 68% wins / 12% SL • 3.8 min avg
 *   Short side: +0.7% MFE / -2.1% MAE • 6.2 min avg
 *   → take
 *
 * Emoji guide:
 *   🟢 = strong/good regime
 *   🟡 = neutral/cautious
 *   🟠 = risky but possible
 *   🔴 = bad regime / strong skip or reverse
 *   ⚠️ = warning prefix
 *   ⚡ = fast momentum / quick wins
 *   🐢 = slow closure
 *
 * @param score     - Computed regime score + breakdown (pure directional from intended side)
 * @param regime    - Full or lite ExcursionRegime (with buy/sell nested aggregates)
 * @param direction - Intended trade direction ('long' = buy, 'short' = sell)
 * @returns Final human-readable multi-line advice string
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
    // 2. DETERMINE MAIN EMOJI & VERDICT BASED ON SIDE SCORE
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
    // 3. BUILD CORE ADVICE LINE – score + verdict
    // ────────────────────────────────────────────────────────────────
    const adviceLines: string[] = [
        `${emoji} ${verdict} (${finalScore.toFixed(1)})`
    ];

    // ────────────────────────────────────────────────────────────────
    // 4. COLLECT DRIVERS & WARNINGS – **pure directional only**
    // ────────────────────────────────────────────────────────────────
    const drivers: string[] = [];
    const warnings: string[] = [];

    // ── Helper: format duration nicely ──────────────────────────────────────────────
    const formatDuration = (ms?: number): string | null => {
        if (!ms || ms <= 0) return null;
        const min = (ms / 60000).toFixed(1);
        if (Number(min) <= 4) return `⚡ fast (${min} min)`;
        if (Number(min) >= 7) return `🐢 slow (${min} min)`;
        return `${min} min`;
    };

    // ── 4.1 Primary side (intended direction) – highlighted first ───────────────────
    const isLong = direction === 'long';
    const primaryAgg = isLong ? regime.buy : regime.sell;
    const primaryLabel = isLong ? 'Long' : 'Short';

    if (primaryAgg && primaryAgg.sampleCount > 0) {
        const dur = formatDuration(primaryAgg.avgDurationMs);
        const mfeStr = primaryAgg.mfe >= 0.5 ? `+${primaryAgg.mfe.toFixed(1)}% MFE` : null;
        const maeAbs = Math.abs(primaryAgg.mae);
        const maeStr = maeAbs >= 1.0 ? `-${maeAbs.toFixed(1)}% MAE` : null;

        const sideLine: string[] = [`${primaryLabel} side:`];
        if (mfeStr) sideLine.push(mfeStr);
        if (maeStr) sideLine.push(maeStr);
        if (dur) sideLine.push(dur);

        if (sideLine.length > 1) {
            drivers.push(sideLine.join(' / '));
        }

        // Primary side outcome summary
        const oc = primaryAgg.outcomeCounts;
        const total = oc.tp + oc.partial_tp + oc.sl + oc.timeout;
        if (total >= 3) {
            const tpPct = ((oc.tp + oc.partial_tp) / total * 100).toFixed(0);
            const slPct = (oc.sl / total * 100).toFixed(0);
            drivers.push(`${tpPct}% wins / ${slPct}% SL (${total} trades)`);
        }

        // Primary side warnings
        if (maeAbs >= 2.5) {
            warnings.push(`${primaryLabel} high drawdown (-${maeAbs.toFixed(1)}%)`);
        }
    }

    // ── 4.2 Opposite side – shown only if data exists (transparency) ───────────────
    const oppositeAgg = isLong ? regime.sell : regime.buy;
    const oppositeLabel = isLong ? 'Short' : 'Long';

    if (oppositeAgg && oppositeAgg.sampleCount > 0) {
        const dur = formatDuration(oppositeAgg.avgDurationMs);
        const mfeStr = oppositeAgg.mfe >= 0.5 ? `+${oppositeAgg.mfe.toFixed(1)}% MFE` : null;
        const maeAbs = Math.abs(oppositeAgg.mae);
        const maeStr = maeAbs >= 1.0 ? `-${maeAbs.toFixed(1)}% MAE` : null;

        const sideLine: string[] = [`${oppositeLabel} side:`];
        if (mfeStr) sideLine.push(mfeStr);
        if (maeStr) sideLine.push(maeStr);
        if (dur) sideLine.push(dur);

        if (sideLine.length > 1) {
            drivers.push(sideLine.join(' / '));
        }

        // Opposite side warning (only drawdown for now)
        if (maeAbs >= 2.5) {
            warnings.push(`${oppositeLabel} high drawdown (-${maeAbs.toFixed(1)}%)`);
        }
    }

    // ── 4.3 Add collected drivers ───────────────────────────────────────────────────
    if (drivers.length > 0) {
        adviceLines.push(`– ${drivers.join(' • ')}`);
    }

    // ────────────────────────────────────────────────────────────────
    // 5. COLLECT SIDE-SPECIFIC TIMING WARNINGS (from score)
    // ────────────────────────────────────────────────────────────────
    if (score.directionalAvgTimeToMFE_ms && score.directionalAvgTimeToMFE_ms > 0) {
        const sec = (score.directionalAvgTimeToMFE_ms / 1000).toFixed(0);
        if (Number(sec) > 180) warnings.push(`late MFE peak (${sec}s)`);
    }

    if (score.directionalAvgTimeToMAE_ms && score.directionalAvgTimeToMAE_ms > 0) {
        const sec = (score.directionalAvgTimeToMAE_ms / 1000).toFixed(0);
        if (Number(sec) <= 60 && Math.abs(primaryAgg?.mae ?? 0) >= 1.0) {
            warnings.push(`rapid drawdown (${sec}s)`);
        }
    }

    // ────────────────────────────────────────────────────────────────
    // 6. ADD WARNINGS LINE IF ANY (side-specific only)
    // ────────────────────────────────────────────────────────────────
    if (warnings.length > 0) {
        adviceLines.push(`| ⚠️ ${warnings.join(' • ')}`);
    }

    // ────────────────────────────────────────────────────────────────
    // 7. ACTION IMPLICATION – final verdict line
    // ────────────────────────────────────────────────────────────────
    let actionText = '→ hold';

    if (finalScore >= 3.8) {
        actionText = '→ strong take';
    } else if (finalScore >= 3.0) {
        actionText = '→ take';
    } else if (finalScore >= 2.0) {
        actionText = '→ cautious take';
    } else if (finalScore <= 1.4) {
        actionText = '→ skip or reverse';
    }

    adviceLines.push(actionText);

    // ────────────────────────────────────────────────────────────────
    // 8. JOIN ALL LINES INTO FINAL MULTI-LINE STRING
    // ────────────────────────────────────────────────────────────────
    return adviceLines.join('\n');
}
