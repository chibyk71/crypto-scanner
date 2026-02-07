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
import { ExcursionHistoryCache, type ExcursionRegime, type ExcursionRegimeLite } from '../services/excursionHistoryCache';

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
const MFE_THRESHOLD = 0.5; // Minimum MFE % to consider a timeout/SL "good" (for scoring sims)
const MAX_MAE_THRESHOLD = 0.5; // Maximum MAE % to consider a sim relevant (for scoring sims)

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
    if (!ExcursionHistoryCache.hasEnoughSamples(regime, 2)) {
        return {
            advice: `⚠️ Too few recent simulations (${regime.recentSampleCount ?? 0}/2) – holding`,
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
 * Compute a single score (0–5) for one completed simulation
 *
 * This is the heart of the 2025 regime scoring system.
 * Goal: Turn each historical sim into a simple numeric "quality" score
 * that reflects how useful/valuable that signal was in hindsight.
 *
 * Scoring philosophy:
 *   - Clear wins (TP/partial_tp) are rewarded highest — +5
 *   - Good-but-not-perfect moves (timeout with strong MFE) get +4
 *   - Losses with some favorable excursion are mildly rewarded +3
 *   - Clean losses (no meaningful MFE) are punished 2
 *   - Time modifiers adjust the base score:
 *     - Fast favorable moves → boost
 *     - Slow or quick adverse moves → penalty
 *     - Fast overall closure → boost
 *
 * Range: -2 to +5 (allows mild punishment for really bad sims)
 *
 * Tunable parameters (hardcoded for now – move to config later):
 *   - mfeThreshold        = 2.0%   → what counts as "strong MFE" for timeouts/SL
 *   - fastMFEThreshold    = 90s    → very quick favorable = strong boost
 *   - slowMFELimit        = 360s   → peak came too late = penalty
 *   - fastMAELimit        = 60s    → rapid drawdown = dangerous
 *   - fastDurationLimit   = 180s   → quick closure = good momentum
 *   - slowDurationLimit   = 420s   → lingering trade = likely chop
 *
 * @param entry         - One completed simulation entry (from cache or historyJson)
 * @returns Numeric score: -2 (bad) to +5 (excellent)
 */
function scoreSingleSimulation(
    entry: SimulationHistoryEntry,
): number {
    // ────────────────────────────────────────────────────────────────
    // 1. EARLY GUARDS – protect against incomplete/malformed entries
    // ────────────────────────────────────────────────────────────────
    if (!entry || typeof entry !== 'object') {
        logger.warn('scoreSingleSimulation received invalid entry – returning 0', { entry });
        return 0;
    }

    // Required fields – fallback safely but warn
    const outcome = entry.outcome ?? 'timeout'; // treat missing outcome as neutral timeout
    const mfe = entry.mfe ?? 0;
    const mae = entry.mae ?? 0;
    const durationMs = entry.durationMs ?? 0;
    const timeToMFE_ms = entry.timeToMFE_ms ?? 0;
    const timeToMAE_ms = entry.timeToMAE_ms ?? 0;

    if (!outcome) {
        logger.warn('Missing outcome in simulation entry – scoring neutrally', { entry });
        return 0;
    }

    // ────────────────────────────────────────────────────────────────
    // 2. BASE SCORE – determined by outcome + MFE threshold
    // ────────────────────────────────────────────────────────────────
    let baseScore = 0;

    switch (outcome) {
        case 'tp':
        case 'partial_tp':
            baseScore = 5;  // Clear win – maximum reward
            break;

        case 'timeout':
            if (mfe >= MFE_THRESHOLD && mae < MAX_MAE_THRESHOLD) {
                baseScore = 4;  // Strong move but didn't hit TP – still very good
            } else if (mae > MAX_MAE_THRESHOLD) {
                baseScore = -2; // MAE too high – likely a bad regime
            } else {
                baseScore = 0;  // No real edge – neutral
            }
            break;

        case 'sl':
            if (mfe >= MFE_THRESHOLD) {
                baseScore = 3;  // Big favorable excursion before SL – trapped or late reversal
            } else if (mfe < 0) {
                baseScore = -2; // Immediate adverse – very bad regime
            } else {
                baseScore = 0; // Clean loss, no upside
            }
            break;

        default:
            logger.warn(`Unknown outcome '${outcome}' in scoreSingleSimulation – neutral score`, { entry });
            baseScore = 0;
    }

    // ────────────────────────────────────────────────────────────────
    // 3. TIME MODIFIERS – adjust base score based on timing factors
    // ────────────────────────────────────────────────────────────────
    let timeModifier = 0;

    // 3.1: How fast did favorable excursion peak? (timeToMFE)
    if (timeToMFE_ms > 0 && timeToMFE_ms <= durationMs) {
        if (timeToMFE_ms <= 120_000) {           // ≤ 2 min = very fast
            timeModifier += 1.0;
        } else if (timeToMFE_ms <= 240_000) {   // ≤ 4 min = fast
            timeModifier += 0.5;
        } else if (timeToMFE_ms > 420_000) {    // > 7 min = too slow
            timeModifier -= 0.5;
        }

        // Penalty if peak came very late in trade life
        if (timeToMFE_ms > durationMs * 0.6) {
            timeModifier -= 0.5;  // Favorable move happened too late → fading
        }
    }

    // 3.2: How fast did adverse excursion happen? (timeToMAE)
    if (timeToMAE_ms > 0 && timeToMAE_ms <= durationMs && mae >= MAX_MAE_THRESHOLD) {
        if (timeToMAE_ms <= 60_000) {           // ≤ 1 min = rapid drawdown
            timeModifier -= 1.0;                // Dangerous volatility
        } else if (timeToMAE_ms <= 120_000) {   // ≤ 2 min = fairly quick
            timeModifier -= 0.5;
        }

        // Bonus if drawdown developed slowly
        if (timeToMAE_ms > durationMs * 0.5) {
            timeModifier += 0.3;  // Drawdown was gradual → possibly controllable
        }
    }

    // 3.3: Overall trade duration (how quickly did it close?)
    if (durationMs > 0) {
        if (durationMs <= 180_000) {            // ≤ 3 min = very fast closure
            timeModifier += 0.8;
        } else if (durationMs <= 360_000) {     // ≤ 6 min = acceptable
            timeModifier += 0.3;
        } else if (durationMs > 420_000) {      // > 7 min = lingering
            timeModifier -= 0.5;
        }
    }

    // ────────────────────────────────────────────────────────────────
    // 4. FINAL SCORE = base + time modifiers (clamp to -2..5)
    // ────────────────────────────────────────────────────────────────
    let finalScore = baseScore + timeModifier;

    // Hard clamp – prevent extreme outliers
    finalScore = Math.max(-2, Math.min(5, finalScore));

    // Optional debug log for individual sim scoring (uncomment during tuning)
    /*
    logger.debug('Scored single simulation', {
        outcome: entry.outcome,
        mfe: entry.mfe?.toFixed(2),
        durationSec: (durationMs / 1000).toFixed(1),
        timeToMFESec: (timeToMFE_ms / 1000).toFixed(1),
        timeToMAESec: (timeToMAE_ms / 1000).toFixed(1),
        baseScore,
        timeModifier: timeModifier.toFixed(2),
        finalScore: finalScore.toFixed(2)
    });
    */

    return finalScore;
}

/**
 * Compute overall regime score from recent simulations
 *
 * Core logic:
 *   1. Selects the relevant set of recent simulations:
 *      - Prefers directional (long/short) if enough samples exist
 *      - Falls back to overall regime data otherwise
 *   2. Scores each individual simulation using scoreSingleSimulation()
 *   3. Applies exponential weighting:
 *      - Most recent sim gets highest weight (e.g. 2.0)
 *      - Weight decays for older simulations (e.g. 1.5, 1.2, 1.0, 0.8...)
 *      → Recent performance matters much more than old data
 *   4. Returns weighted average score + detailed breakdown
 *
 * Why exponential weighting?
 *   - Scalping regimes change quickly — last 1–2 sims are far more predictive
 *   - Prevents old good/bad trades from dominating current advice
 *
 * Tunable parameters (hardcoded for now – move to config later):
 *   - maxSims           = 5      → how many recent sims to consider
 *   - minDirectional    = 2      → min directional samples to prefer direction
 *   - baseWeight        = 2.0    → weight of most recent sim
 *   - weightDecayFactor = 0.75   → each older sim multiplies previous weight by this
 *
 * Safety features:
 *   - Handles missing/undefined fields gracefully (falls back to 0 score)
 *   - Returns safe defaults if no usable sims
 *   - Clamps final score to reasonable range (-2 to 5)
 *
 * @param regime     - Full or lite regime object from cache
 * @param direction  - Intended trade direction ('long' | 'short')
 * @param maxSims    - Maximum number of recent sims to evaluate (default 5)
 * @returns ExcursionScore object with total weighted score + breakdown
 */
function computeRegimeScore(
    regime: ExcursionRegime,
    direction: 'long' | 'short',
): ExcursionScore {
    // ────────────────────────────────────────────────────────────────
    // 1. EARLY GUARD: No data at all → return safe neutral score
    // ────────────────────────────────────────────────────────────────
    if (!regime || regime.recentSampleCount <= 0) {
        logger.debug('computeRegimeScore: no samples available – returning neutral', {
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

    // ────────────────────────────────────────────────────────────────
    // 2. SELECT RELEVANT SIMULATIONS (prefer directional when possible)
    // ────────────────────────────────────────────────────────────────
    let simsToScore: (SimulationHistoryEntry)[] = [];

    // Try directional first (more specific)
    if (direction === 'long' && regime.recentSampleCountLong && regime.recentSampleCountLong >= 2) {
        // We have enough long-specific data → use directional long history if available
        if ('historyJson' in regime && regime.historyJson) {
            simsToScore = regime.historyJson.filter(e => e.direction === 'buy');
        }
        // Fallback: if no historyJson, we can't do directional → use overall
        if (simsToScore.length === 0) {
            simsToScore = regime.historyJson ?? [];
        }
    } else if (direction === 'short' && regime.recentSampleCountShort && regime.recentSampleCountShort >= 2) {
        if ('historyJson' in regime && regime.historyJson) {
            simsToScore = regime.historyJson.filter(e => e.direction === 'sell');
        }
        if (simsToScore.length === 0) {
            simsToScore = regime.historyJson ?? [];
        }
    } else {
        // No sufficient directional data → use overall history
        if ('historyJson' in regime && regime.historyJson) {
            simsToScore = regime.historyJson;
        }
    }

    // Limit to maxSims most recent (already sorted newest first in cache)
    simsToScore = simsToScore.slice(0, MAX_SIMS);

    if (simsToScore.length === 0) {
        logger.debug('computeRegimeScore: no usable sims after filtering – neutral score', {
            symbol: regime.symbol,
            direction,
            availableSamples: regime.recentSampleCount,
        });
        return {
            totalScore: 0,
            baseScore: 0,
            timeModifier: 0,
            individualScores: [],
        };
    }

    // ────────────────────────────────────────────────────────────────
    // 3. SCORE EACH SIMULATION + COLLECT RAW SCORES
    // ────────────────────────────────────────────────────────────────
    const individualScores: number[] = [];
    let sumWeightedScore = 0;
    let sumWeights = 0;

    // Exponential weighting: most recent = highest weight
    const baseWeight = 2.0;           // weight of newest sim
    const weightDecay = 0.8;         // each older sim multiplies previous weight by this

    let currentWeight = baseWeight;

    for (const entry of simsToScore) {
        const rawScore = scoreSingleSimulation(entry);
        individualScores.push(rawScore);

        // Apply weight to this sim's score
        sumWeightedScore += rawScore * currentWeight;
        sumWeights += currentWeight;

        // Decay weight for next (older) sim
        currentWeight *= weightDecay;
    }

    // ────────────────────────────────────────────────────────────────
    // 4. COMPUTE FINAL WEIGHTED AVERAGE SCORE
    // ────────────────────────────────────────────────────────────────
    const totalScore = sumWeights > 0 ? sumWeightedScore / sumWeights : 0;

    // Clamp final score to reasonable range (same as individual scores)
    const clampedScore = Math.max(-2, Math.min(5, totalScore));

    // ────────────────────────────────────────────────────────────────
    // 5. BUILD & RETURN SCORE BREAKDOWN
    // ────────────────────────────────────────────────────────────────
    const result: ExcursionScore = {
        totalScore: clampedScore,
        baseScore: totalScore, // for now – we can separate time modifiers later if needed
        timeModifier: 0,       // placeholder – could compute average modifier if we want
        individualScores,
    };

    // Optional debug log – shows how score was built (uncomment during tuning)
    /*
    logger.debug('Regime score computed', {
        symbol: regime.symbol,
        direction,
        simCount: simsToScore.length,
        individualScores: individualScores.map(s => s.toFixed(2)),
        weights: simsToScore.map((_, i) => (baseWeight * Math.pow(weightDecay, i)).toFixed(2)),
        weightedSum: sumWeightedScore.toFixed(2),
        totalWeight: sumWeights.toFixed(2),
        finalScore: clampedScore.toFixed(2),
    });
    */

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
 * Score interpretation guide (2025 scalping defaults):
 *   ≥ 3.8     → strong take     (very high conviction – widen TP, boost confidence)
 *   3.0–3.79  → take           (solid edge – normal size, mild boost)
 *   2.0–2.99  → cautious take  (acceptable but reduce risk – tighten SL)
 *   1.0–1.99  → skip / minimal (weak signal – very small size or skip)
 *   ≤ 0.99    → reverse / skip (bad regime – flip direction or avoid entirely)
 *
 * Tunable thresholds (hardcoded for now – extract to config.strategy later):
 *   STRONG_TAKE_THRESHOLD   = 3.8
 *   TAKE_THRESHOLD          = 3.0
 *   CAUTIOUS_THRESHOLD      = 2.0
 *   REVERSE_THRESHOLD       = 0.99
 *   CONFIDENCE_BOOST_RANGE  = -0.30 to +0.30
 *   SL_MULTIPLIER_RANGE     = 0.60 to 1.20
 *   TP_MULTIPLIER_RANGE     = 0.90 to 1.40
 *
 * Safety principles:
 *   - Never returns extreme multipliers (clamped)
 *   - Prefers 'skip' over aggressive 'reverse' when borderline
 *   - Returns base advice string for further embellishment in buildAdviceString
 *
 * @param score      - Result from computeRegimeScore (totalScore + breakdown)
 * @param direction  - Intended trade direction ('long' | 'short')
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
                confidenceBoost: -0.30, // heavy penalty for bad data
            },
            action: 'skip'
        };
    }

    const finalScore = score.totalScore;

    // ────────────────────────────────────────────────────────────────
    // 2. DEFINE THRESHOLDS & ADJUSTMENT MAPPINGS
    //    All values are explicit and easy to change/tune
    // ────────────────────────────────────────────────────────────────
    const STRONG_TAKE_THRESHOLD = 3.8;
    const TAKE_THRESHOLD = 3.0;
    const CAUTIOUS_THRESHOLD = 2.0;
    const REVERSE_THRESHOLD = 0.99;

    let action: ExcursionAction = 'skip';
    let baseAdvice = '';
    let slMult = 1.0;
    let tpMult = 1.0;
    let confBoost = 0.0;

    // ────────────────────────────────────────────────────────────────
    // 3. DECISION TREE – map score ranges to action & adjustments
    // ────────────────────────────────────────────────────────────────
    if (finalScore >= STRONG_TAKE_THRESHOLD) {
        // Very strong regime – high conviction
        action = 'take';
        baseAdvice = `🟢 Strong regime (${finalScore.toFixed(2)}) – high conviction take`;
        slMult = 1.10;          // slight loosen SL (momentum is strong)
        tpMult = 1.40;          // widen TP to capture more
        confBoost = 0.30;       // significant confidence increase

    } else if (finalScore >= TAKE_THRESHOLD) {
        // Solid edge – proceed normally
        action = 'take';
        baseAdvice = `🟢 Good regime (${finalScore.toFixed(2)}) – take`;
        slMult = 1.00;          // neutral SL
        tpMult = 1.25;          // moderate TP expansion
        confBoost = 0.15;       // mild boost

    } else if (finalScore >= CAUTIOUS_THRESHOLD) {
        // Acceptable but risky – reduce exposure
        action = 'take';
        baseAdvice = `🟠 Cautious regime (${finalScore.toFixed(2)}) – take small/reduced`;
        slMult = 0.85;          // tighten SL for protection
        tpMult = 1.10;          // slight TP expansion only
        confBoost = -0.05;      // small penalty

    } else if (finalScore >= REVERSE_THRESHOLD) {
        // Weak or neutral – better to skip
        action = 'skip';
        baseAdvice = `🟡 Weak regime (${finalScore.toFixed(2)}) – skip or minimal size`;
        slMult = 0.75;          // much tighter SL if taken
        tpMult = 0.90;          // reduce TP targets
        confBoost = -0.20;      // confidence penalty

    } else {
        // Bad regime – consider reverse or strong skip
        // Only reverse if score is clearly negative AND directional data supports it
        const shouldReverse = finalScore <= 0.5 && score.individualScores.length >= 6 && score.individualScores.filter(s => s <= 0).length >= 4;

        if (shouldReverse) {
            action = 'reverse';
            baseAdvice = `🔴 Poor regime (${finalScore.toFixed(2)}) – consider reverse`;
            slMult = 0.70;      // very tight SL on reverse trade
            tpMult = 1.30;      // reward potential reversal
            confBoost = -0.10;  // still cautious on reverse
        } else {
            action = 'skip';
            baseAdvice = `🔴 Bad regime (${finalScore.toFixed(2)}) – strong skip`;
            slMult = 0.60;      // extremely tight if forced
            tpMult = 0.80;      // minimal TP
            confBoost = -0.30;  // heavy penalty
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
 * Tunable elements (hardcoded for now – easy to extract later):
 *   - High/low score thresholds for emoji choice
 *   - Duration thresholds for "fast/slow" phrasing
 *   - Warning inclusion if confidenceBoost < -0.1 or slMultiplier < 0.9
 *
 * @param score     - Computed regime score + breakdown
 * @param regime    - Regime data (for outcome counts, duration, MFE/MAE)
 * @param direction - Trade direction ('long' | 'short')
 * @returns Final human-readable advice string (e.g. "🟢 Strong regime (4.1) – fast wins + good MFE → take")
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
    const avgDurationSec = (regime.avgDurationMs ?? 0) / 1000;
    const avgDurationMin = avgDurationSec / 60;

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

    // 4.1 Duration insight
    if (avgDurationMin > 0) {
        if (avgDurationMin <= 4) {
            drivers.push(`⚡ fast wins (${avgDurationMin.toFixed(1)} min avg)`);
        } else if (avgDurationMin >= 7) {
            drivers.push(`🐢 slow regime (${avgDurationMin.toFixed(1)} min avg)`);
        } else {
            drivers.push(`normal duration (${avgDurationMin.toFixed(1)} min)`);
        }
    }

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

    // 4.3 Outcome summary (only if meaningful counts)
    const oc = regime.outcomeCounts ?? { tp: 0, partial_tp: 0, sl: 0, timeout: 0 };
    const totalOutcomes = oc.tp + oc.partial_tp + oc.sl + oc.timeout;
    if (totalOutcomes >= 3) {
        const tpPct = ((oc.tp + oc.partial_tp) / totalOutcomes * 100).toFixed(0);
        const slPct = (oc.sl / totalOutcomes * 100).toFixed(0);
        drivers.push(`${tpPct}% wins / ${slPct}% SL`);
    }

    // Add drivers to advice
    if (drivers.length > 0) {
        advice += ` – ${drivers.join(' + ')}`;
    }

    // ────────────────────────────────────────────────────────────────
    // 5. ADD DIRECTIONAL CONTEXT (long/short specific)
    // ────────────────────────────────────────────────────────────────
    if (direction === 'long') {
        advice += ` (long bias)`;
    } else if (direction === 'short') {
        advice += ` (short bias)`;
    }

    // ────────────────────────────────────────────────────────────────
    // 6. COLLECT & APPEND WARNINGS (if any risky factors)
    // ────────────────────────────────────────────────────────────────
    const warnings: string[] = [];

    // High drawdown warning
    if (absMae >= 2.5) {
        warnings.push(`high drawdown (-${absMae.toFixed(1)}%)`);
    }

    // Slow regime warning
    if (avgDurationMin > 7) {
        warnings.push(`slow closure`);
    }

    // High SL streak warning
    if (regime.slStreak >= 2) {
        warnings.push(`SL streak: ${regime.slStreak}`);
    }

    // Low confidence / high timeout warning
    if (regime.timeoutRatio > 0.5) {
        warnings.push(`high timeouts`);
    }

    // Append warnings if present
    if (warnings.length > 0) {
        advice += ` | ⚠️ ${warnings.join(' | ')}`;
    }

    // ────────────────────────────────────────────────────────────────
    // 7. FINAL TOUCH – action implication if strong/weak
    // ────────────────────────────────────────────────────────────────
    if (finalScore >= 3.8) {
        advice += ` → strong take`;
    } else if (finalScore <= 0.99) {
        advice += ` → skip or reverse`;
    } else if (finalScore >= 3.0) {
        advice += ` → take`;
    } else {
        advice += ` → hold`;
    }

    return advice;
}
