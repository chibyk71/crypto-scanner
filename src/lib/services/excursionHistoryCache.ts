// src/lib/services/excursionHistoryCache.ts
// =============================================================================
// EXCURSION HISTORY CACHE – CENTRALIZED SOURCE OF TRUTH FOR SIMULATION METRICS
//
// Fresh 2025 implementation:
//   • Focused exclusively on completed simulations (no live tracking)
//   • Max 10 most recent completed simulations per symbol (after time pruning)
//   • Configurable 2-hour recency window
//   • Enriched with outcome counts, directional outcomes, SL streak, timeout ratio
//   • Aggregates recomputed on write + during periodic cleanup
// =============================================================================

import { createLogger } from '../logger';
import { config } from '../config/settings';
import type { SimulationHistoryEntry } from '../../types/signalHistory';
import type { SignalLabel, SimulationOutcome } from '../../types';
import type { SimulatedTrade } from '../db/schema';
import { dbService } from '../db';

const logger = createLogger('ExcursionCache');

// ──────────────────────────────────────────────────────────────────────────────
// Configuration constants (overridable via config)
// ──────────────────────────────────────────────────────────────────────────────

const RECENT_WINDOW_HOURS_DEFAULT = 3; // 3 hours default recency window for simulations included in regime (tune as needed)
const MAX_CLOSED_SIMS_PER_SYMBOL = 10;
const MIN_SAMPLES_FOR_TRUST_DEFAULT = 3;

/**
 * Direction of a trade (used consistently across cache, regime, and advice)
 */
type Direction = 'buy' | 'sell';

/**
 * Long/short mapping for advice calls (more semantic than 'buy'/'sell')
 */
type LongShort = 'long' | 'short';

/**
 * Reusable structure for aggregates of **one single direction** (buy or sell)
 * All decision-relevant stats live here — no combined fallback allowed
 */
interface DirectionalAggregates {
    /** Number of completed simulations in this exact direction */
    sampleCount: number;

    /** Average maximum favorable excursion (always ≥ 0) */
    mfe: number;

    /** Average maximum adverse excursion (always ≤ 0) */
    mae: number;

    /** Ratio MFE / |MAE| — higher = better regime for this direction */
    excursionRatio: number;

    /** Average trade duration in milliseconds for this direction */
    avgDurationMs: number;

    /** Outcome distribution — only for this direction */
    outcomeCounts: {
        tp: number;
        partial_tp: number;
        sl: number;
        timeout: number;
    };

    /** Optional derived win rate (e.g. (tp + partial_tp) / total) */
    winRate?: number;
}

/**
 * Cached entry – strictly for completed simulations only.
 * Internal representation stored in the cache Map.
 */
interface CachedSimulationEntry extends SimulationHistoryEntry {
    signalId: string;
    timestamp: number;          // completion timestamp (ms since epoch)
    direction: Direction;       // 'buy' or 'sell' – used to split into directional buckets

    // Timing fields from simulation (critical for scalping analysis)
    durationMs: number;         // total trade duration in milliseconds
    timeToMFE_ms: number;       // ms from entry to peak favorable excursion
    timeToMAE_ms: number;       // ms from entry to peak adverse excursion
}

/**
 * Score breakdown for a single simulation (0–5 scale)
 * Used for regime advice, weighted aggregates, and ML label mapping
 */
interface SimulationScore {
    baseScore: number;          // 0–5 from outcome + excursion table
    timeModifier: number;       // -1.5 to +1.8 from magnitude-gated timing
    totalScore: number;         // Final clamped 0–5
}

/**
 * Full regime – returned by getRegime(symbol)
 *
 * 2026+ pure directional design:
 *   - All meaningful aggregates (MFE/MAE/ratio/duration/outcomes) live **only** inside buy/sell
 *   - Combined fields are minimal — used **only** for:
 *     • Alert gate: recentSampleCount >= 3
 *     • Overview warnings: slStreak, timeoutRatio
 *   - No combined MFE/MAE/ratio/avgDurationMs — no fallback allowed
 *   - Decision logic must use buy or sell aggregates exclusively
 */
export interface ExcursionRegime {
    symbol: string;

    /** Optional: most recent entries shown in alerts (newest first, capped) */
    historyJson?: SimulationHistoryEntry[];

    // ── Minimal combined fields – ONLY for alert gate & basic warnings ───────────
    /** Total recent completed simulations (buy + sell) – used ONLY for alert gate */
    recentSampleCount: number;

    /** Consecutive SL streak across all directions (from newest) */
    slStreak: number;

    /** Overall timeout ratio (timeout / total) – overview only */
    timeoutRatio: number;

    // ── Pure directional aggregates – these are the source of truth ──────────────
    /** Buy / Long side statistics – used for long signals */
    buy?: DirectionalAggregates;

    /** Sell / Short side statistics – used for short signals */
    sell?: DirectionalAggregates;

    // Optional directional streaks (can be populated if needed later)
    slStreakBuy?: number;
    slStreakSell?: number;

    // ── Fixed ────────────────────────────────────────────────────────────────────
    /** Always 0 – no live tracking here */
    activeCount: 0;

    /** Last computation time */
    updatedAt: Date;
}

/**
 * Lightweight version – no historyJson array
 * Used in performance-critical paths (advice, status checks)
 */
export interface ExcursionRegimeLite
    extends Omit<ExcursionRegime, 'historyJson'> { }

/**
* Tunable thresholds for 2026 scalping scoring (excursion-dominant)
* Move to config later for live tuning
*/
const SCORE_THRESHOLDS = {
    mfeGood: 0.5,               // % — meaningful favorable excursion
    mfeDecent: 0.25,
    maeMaxGood: 1.0,            // % — acceptable adverse
    ratioReverse: 0.6,          // MAE > MFE / 0.6 → MAE dominates
    earlyTimeMs: 5 * 60 * 1000,  // 5 minutes
    fastCloseMs: 5 * 60 * 1000,  // Fast overall close bonus
    slowCloseMs: 8 * 60 * 1000,  // Slow close penalty
    earlyMfeBonusMs: 3 * 60 * 1000,
    rapidMaePenaltyMs: 2 * 60 * 1000,
    lateMfePenaltyRatio: 0.7,   // >70% of duration = late peak
};

/**
 * Central cache manager – completed simulations only
 */
export class ExcursionHistoryCache {
    // ──────────────────────────────────────────────────────────────────────────────
    // Private properties (storage & config)
    // ──────────────────────────────────────────────────────────────────────────────

    private cache: Map<string, CachedSimulationEntry[]>;           // symbol → completed entries (newest first)
    private aggregates: Map<string, ExcursionRegime>;              // symbol → precomputed regime

    private recentWindowMs: number;                                // 2 hours default
    private maxClosedSims: number;                                 // 10 default
    private cleanupIntervalMs: number = 30 * 60_000;               // 30 min periodic cleanup

    private cleanupTimer: NodeJS.Timeout | null = null;

    // ──────────────────────────────────────────────────────────────────────────────
    // Constructor – initialize storage & start periodic cleanup
    // ──────────────────────────────────────────────────────────────────────────────
    constructor() {
        // ────────────────────────────────────────────────────────────────
        // 1. Initialize internal storage
        //    - cache: stores raw completed simulation entries per symbol
        //    - aggregates: precomputed directional + combined regime stats
        // ────────────────────────────────────────────────────────────────
        this.cache = new Map<string, CachedSimulationEntry[]>();
        this.aggregates = new Map<string, ExcursionRegime>();

        // ────────────────────────────────────────────────────────────────
        // 2. Apply configuration with safe defaults
        //    All values are clamped to prevent invalid states
        // ────────────────────────────────────────────────────────────────
        const windowHours = Math.max(1, RECENT_WINDOW_HOURS_DEFAULT); // min 1 hour
        this.recentWindowMs = windowHours * 60 * 60 * 1000;

        // Max simulations kept per symbol (total, not per side yet)
        // In future we might split to max per direction
        this.maxClosedSims = Math.max(5, MAX_CLOSED_SIMS_PER_SYMBOL ?? 10);

        // Cleanup runs every 30 minutes by default
        // Can be made configurable later if needed
        this.cleanupIntervalMs = 30 * 60 * 1000;

        // ────────────────────────────────────────────────────────────────
        // 3. Log initialization details for debugging & monitoring
        // ────────────────────────────────────────────────────────────────
        logger.info('ExcursionHistoryCache initialized (completed simulations only)', {
            recentWindowHours: this.recentWindowMs / (60 * 60 * 1000),
            maxClosedSimsPerSymbol: this.maxClosedSims,
            cleanupIntervalMinutes: this.cleanupIntervalMs / 60_000,
            note: 'Directional (buy/sell) aggregates will be computed separately'
        });

        // ────────────────────────────────────────────────────────────────
        // 4. Start periodic background cleanup
        //    - Removes old entries outside the time window
        //    - Caps number of stored simulations
        //    - Recomputes aggregates after pruning
        // ────────────────────────────────────────────────────────────────
        this.cleanupTimer = setInterval(() => {
            try {
                this.cleanup();
            } catch (err) {
                logger.error('Periodic cleanup failed – continuing anyway', {
                    error: err instanceof Error ? err.message : String(err),
                    stack: err instanceof Error ? err.stack : undefined
                });
                // Do NOT re-throw → keep the interval alive
            }
        }, this.cleanupIntervalMs);
    }

    /**
     * Maps final 0–5 score to ML label (-2 to +2)
     * Asymmetric: higher bar for positive labels (scalping favors clear/quick wins)
     */
    public mapScoreToLabel(score: number): SignalLabel {
        if (score >= 4.0) return 2;      // Excellent – strong conviction win
        if (score >= 3.0) return 1;      // Good – solid outcome
        if (score >= 2.0) return 0;      // Neutral – no strong edge
        if (score >= 1.0) return -1;     // Small loss / reverse hint
        return -2;                       // Disaster – strong reverse / regime warning
    }

    /**
     * Computes a nuanced 0–5 score for one completed simulation.
     *
     * 2026 scalping philosophy:
     *   - Excursion-dominant for non-TP outcomes (timeout/SL)
     *   - Magnitude-gated time modifiers: only meaningful excursions (≥1.0%) trigger bonuses/penalties
     *   - Early meaningful MFE = strong momentum
     *   - Fast clean SL + low MFE = strong reverse candidate
     *   - MAE dominance in timeout = reverse candidate
     *   - Fast close = good regardless of size
     *
     * This score drives:
     *   - Regime advice (higher = take, lower = skip/reverse)
     *   - Weighted aggregates (future enhancement)
     *   - ML labels (via mapScoreToLabel)
     *
     * @param entry Cached entry with full outcome & metrics
     * @returns SimulationScore with breakdown + final clamped 0–5 score
     */
    public computeSimulationScore(entry: Partial<CachedSimulationEntry>): SimulationScore {
        // Early guards
        if (!entry || typeof entry !== 'object') {
            logger.warn('computeSimulationScore received invalid entry – returning 0');
            return { baseScore: 0, timeModifier: 0, totalScore: 0 };
        }

        const outcome = entry.outcome ?? 'timeout';
        const mfe = entry.mfe ?? 0;
        const absMae = Math.abs(entry.mae ?? 0);
        const durationMs = entry.durationMs ?? 0;
        const timeToMfeMs = entry.timeToMFE_ms ?? 0;
        const timeToMaeMs = entry.timeToMAE_ms ?? 0;

        // ── 1. Base score – excursion-dominant table ───────────────────────
        let baseScore = 0;

        if (outcome === 'tp' || outcome === 'partial_tp') {
            baseScore = 5.0; // Clear win — highest possible
        } else if (outcome === 'timeout') {
            if (mfe >= SCORE_THRESHOLDS.mfeGood && absMae < SCORE_THRESHOLDS.maeMaxGood) {
                baseScore = 4.5; // Excellent excursion — near-win
            } else if (mfe >= SCORE_THRESHOLDS.mfeDecent && absMae < SCORE_THRESHOLDS.maeMaxGood) {
                baseScore = 3.5; // Decent excursion
            } else if (absMae > mfe / SCORE_THRESHOLDS.ratioReverse) {
                baseScore = 0.5; // MAE dominates — strong reverse candidate
            } else {
                baseScore = 2.0; // Neutral timeout
            }
        } else if (outcome === 'sl') {
            if (mfe >= SCORE_THRESHOLDS.mfeGood && timeToMfeMs <= SCORE_THRESHOLDS.earlyTimeMs) {
                baseScore = 3.0; // Early meaningful MFE — trapped but good momentum
            } else if (mfe >= SCORE_THRESHOLDS.mfeDecent) {
                baseScore = 2.0; // Some favorable potential
            } else if (durationMs <= SCORE_THRESHOLDS.earlyTimeMs && mfe < SCORE_THRESHOLDS.mfeDecent) {
                baseScore = 0.0; // Fast clean loss — strong reverse sign
            } else {
                baseScore = 0.0; // Bad loss but not strong reverse
            }
        }

        // ── 2. Magnitude-gated time modifiers ───────────────────────────────
        let timeModifier = 0;

        // Fast close = good momentum (no magnitude gate — quick resolution always positive)
        if (durationMs <= SCORE_THRESHOLDS.fastCloseMs && outcome !== 'sl') timeModifier += 1.0;
        if (durationMs > SCORE_THRESHOLDS.slowCloseMs) timeModifier -= 0.5;

        // Early meaningful MFE = strong momentum (only if meaningful excursion)
        if (timeToMfeMs <= SCORE_THRESHOLDS.earlyMfeBonusMs && mfe >= SCORE_THRESHOLDS.mfeGood) {
            timeModifier += 0.8;
        }

        // Rapid meaningful drawdown = dangerous volatility (only if meaningful MAE)
        if (timeToMaeMs <= SCORE_THRESHOLDS.rapidMaePenaltyMs && absMae >= SCORE_THRESHOLDS.mfeGood) {
            timeModifier -= 1.0;
        }

        // Late meaningful peak = fading momentum (only if meaningful MFE)
        if (timeToMfeMs > durationMs * SCORE_THRESHOLDS.lateMfePenaltyRatio && mfe >= SCORE_THRESHOLDS.mfeGood) {
            timeModifier -= 0.5;
        }

        // Clamp modifier to reasonable range
        timeModifier = Math.max(-1.5, Math.min(1.8, timeModifier));

        // ── 3. Final score ───────────────────────────────────────────────────
        let totalScore = baseScore + timeModifier;
        totalScore = Math.max(0, Math.min(5, totalScore));

        // Optional debug logging (uncomment during tuning)
        /*
        logger.debug('Scored simulation', {
            symbol: entry.symbol,
            outcome,
            mfe: mfe.toFixed(2),
            mae: -absMae.toFixed(2),
            durationMin: (durationMs / 60000).toFixed(1),
            timeToMfeMin: (timeToMfeMs / 60000).toFixed(1),
            timeToMaeMin: (timeToMaeMs / 60000).toFixed(1),
            baseScore: baseScore.toFixed(2),
            timeModifier: timeModifier.toFixed(2),
            totalScore: totalScore.toFixed(2),
        });
        */

        return { baseScore, timeModifier, totalScore };
    }

    /**
     * Adds a newly completed simulation to the per-symbol cache.
     * - Validates required fields (strict integrity check)
     * - Computes nuanced 0–5 score + ML label
     * - Enriches entry with score/label
     * - Maintains newest-first order
     * - Prunes old entries (time window) and caps total size
     * - Triggers directional + combined aggregate recompute
     *
     * Called from: simulateTrade (after successful DB insert)
     * Design notes:
     *   - Simulations are immutable → add-only, no updates
     *   - Pruning is total (combined buy+sell) for simplicity
     *   - Directional separation happens downstream in recomputeAggregates
    */
    public addCompletedSimulation(symbol: string, entry: Partial<CachedSimulationEntry>): void {
        // ── 1. Early validation ────────────────────────────────────────────────
        if (!entry || typeof entry !== 'object') {
            logger.warn('addCompletedSimulation received invalid entry – rejected');
            return;
        }

        symbol = symbol.trim().toUpperCase();
        if (!symbol) {
            logger.warn('Missing or empty symbol in simulation entry – rejected');
            return;
        }

        // Required fields – strict check for data quality
        const missingFields = [
            !entry.signalId && 'signalId',
            entry.timestamp == null && 'timestamp',
            (!entry.direction || !['buy', 'sell'].includes(entry.direction)) && 'direction',
            (!entry.outcome || !['tp', 'partial_tp', 'sl', 'timeout'].includes(entry.outcome)) && 'outcome',
            entry.mfe === undefined && 'mfe',
            entry.mae === undefined && 'mae',
            entry.durationMs == null && 'durationMs',
            entry.timeToMFE_ms == null && 'timeToMFE_ms',
            entry.timeToMAE_ms == null && 'timeToMAE_ms',
        ].filter(Boolean) as string[];

        if (missingFields.length > 0) {
            logger.warn('Incomplete simulation entry – rejected', {
                symbol,
                signalId: entry.signalId ?? 'unknown',
                direction: entry.direction ?? 'missing',
                missingFields,
            });
            return;
        }

        // Type assertion – safe after validation
        const validatedEntry = entry as CachedSimulationEntry;

        // ── 2. Compute score & label ───────────────────────────────────────────
        const { totalScore } = this.computeSimulationScore(validatedEntry);
        const label = this.mapScoreToLabel(totalScore);

        // Enrich with computed values
        const enrichedEntry: CachedSimulationEntry & { score: number; label: SignalLabel } = {
            ...validatedEntry,
            score: totalScore,
            label,
        };

        // ── 3. Defensive timing sanity check ──────────────────────────────────
        if (
            enrichedEntry.durationMs < 0 ||
            enrichedEntry.timeToMFE_ms < 0 ||
            enrichedEntry.timeToMAE_ms < 0 ||
            enrichedEntry.timeToMFE_ms > enrichedEntry.durationMs ||
            enrichedEntry.timeToMAE_ms > enrichedEntry.durationMs
        ) {
            logger.warn('Suspicious timing values detected in simulation', {
                symbol,
                signalId: enrichedEntry.signalId,
                direction: enrichedEntry.direction,
                durationMs: enrichedEntry.durationMs,
                timeToMFE_ms: enrichedEntry.timeToMFE_ms,
                timeToMAE_ms: enrichedEntry.timeToMAE_ms,
            });
            // Still accept — just warn (data might still be useful)
        }

        // ── 4. Add to cache ────────────────────────────────────────────────────
        let sims = this.cache.get(symbol) ?? [];

        sims.push(enrichedEntry);

        // Keep newest first
        sims.sort((a, b) => b.timestamp - a.timestamp);

        // ── 5. Prune old / excess entries ──────────────────────────────────────
        const cutoff = Date.now() - this.recentWindowMs;
        sims = sims.filter(s => s.timestamp >= cutoff);

        // Cap total simulations per symbol (combined buy + sell)
        if (sims.length > this.maxClosedSims) {
            sims = sims.slice(0, this.maxClosedSims);
        }

        // ── 6. Update storage ──────────────────────────────────────────────────
        if (sims.length === 0) {
            this.cache.delete(symbol);
            this.aggregates.delete(symbol);
            logger.debug(`Cache emptied for symbol after prune`, { symbol });
        } else {
            this.cache.set(symbol, sims);
        }

        // ── 7. Recompute aggregates (directional + combined) ───────────────────
        this.recomputeAggregates(symbol);

        // ── 8. Log success ─────────────────────────────────────────────────────
        logger.info(`Added & scored new simulation`, {
            symbol,
            signalId: enrichedEntry.signalId,
            direction: enrichedEntry.direction,
            outcome: enrichedEntry.outcome,
            score: totalScore.toFixed(2),
            label,
            cacheSizeAfter: sims.length,
            note: 'Aggregates recomputed (buy/sell split applied)'
        });
    }

    /**
 * Private method: Recomputes all aggregate statistics and outcome-derived fields
 * for a single symbol based on its current (pruned) list of completed simulations.
 *
 * Called from:
 *   - addCompletedSimulation() — after every new entry/prune
 *   - cleanup() — after periodic pruning
 *   - Potentially from getRegime() on cache miss (future-proof)
 *
 * Key design principles for directional regime (2026+):
 *   - Combined stats (recentSampleCount, slStreak, timeoutRatio) used for alert gate & overview
 *   - All decision-critical stats (MFE/MAE/ratio/outcomes/duration) computed PER DIRECTION
 *   - Directional fields are optional (undefined if zero samples in that direction)
 *   - activeCount permanently 0 — only completed simulations matter
 *   - Computation remains fast (O(n) with n ≤ 10)
 *
 * @param symbol Normalized uppercase symbol (e.g. 'BTC/USDT')
 */
    private recomputeAggregates(symbol: string): void {
        // ── STEP 1: Early exit if no entries ───────────────────────────────────────
        const entries = this.cache.get(symbol);

        if (!entries || entries.length === 0) {
            const hadAggregate = this.aggregates.delete(symbol);
            if (hadAggregate) {
                logger.debug('Removed stale aggregate for symbol with no entries', { symbol });
            }
            return;
        }

        // ── STEP 2: Split entries by direction ──────────────────────────────────────
        const buyEntries = entries.filter(e => e.direction === 'buy');
        const sellEntries = entries.filter(e => e.direction === 'sell');

        const combinedCount = entries.length;

        // ── STEP 3: Helper to compute aggregates for one direction ──────────────────
        const computeDirectional = (dirEntries: CachedSimulationEntry[]): DirectionalAggregates | undefined => {
            if (dirEntries.length === 0) return undefined;

            const mfeValues = dirEntries.map(e => e.mfe ?? 0);
            const maeValues = dirEntries.map(e => Math.abs(e.mae ?? 0)); // absolute for averaging
            const durationMs = dirEntries.map(e => e.durationMs ?? 0);

            const mfe = this.safeAvg(mfeValues);
            const mae = -this.safeAvg(maeValues); // back to negative
            const ratio = mfe / (Math.abs(mae) || 1); // avoid div/0

            const outcomeCounts = { tp: 0, partial_tp: 0, sl: 0, timeout: 0 };
            dirEntries.forEach(e => {
                const o = e.outcome;
                if (o && o in outcomeCounts) outcomeCounts[o as keyof typeof outcomeCounts]++;
            });

            return {
                sampleCount: dirEntries.length,
                mfe,
                mae,
                excursionRatio: ratio,
                avgDurationMs: this.safeAvg(durationMs),
                outcomeCounts,
            };
        };

        const buyAgg = computeDirectional(buyEntries);
        const sellAgg = computeDirectional(sellEntries);

        // ── STEP 4: Combined stats (for alert gate & overview) ──────────────────────
        let slStreak = 0;
        for (const e of entries) { // newest first
            if (e.outcome === 'sl') slStreak++;
            else break;
        }

        const totalTimeouts = (buyAgg?.outcomeCounts.timeout ?? 0) + (sellAgg?.outcomeCounts.timeout ?? 0);
        const timeoutRatio = combinedCount > 0 ? totalTimeouts / combinedCount : 0;

        // ── STEP 5: Build fresh regime object ───────────────────────────────────────
        const freshRegime: ExcursionRegime = {
            symbol,
            historyJson: entries.map(e => ({ ...e }) as SimulationHistoryEntry).slice(0, 5), // cap for alerts

            recentSampleCount: combinedCount,
            slStreak,
            timeoutRatio,

            buy: buyAgg,
            sell: sellAgg,

            activeCount: 0,
            updatedAt: new Date(),
        };

        // ── STEP 6: Store & log ─────────────────────────────────────────────────────
        this.aggregates.set(symbol, freshRegime);

        logger.debug('Directional aggregates recomputed', {
            symbol,
            totalSamples: combinedCount,
            buySamples: buyAgg?.sampleCount ?? 0,
            sellSamples: sellAgg?.sampleCount ?? 0,
            buyMfeMae: buyAgg ? `${buyAgg.mfe.toFixed(3)} / ${buyAgg.mae.toFixed(3)}` : 'n/a',
            sellMfeMae: sellAgg ? `${sellAgg.mfe.toFixed(3)} / ${sellAgg.mae.toFixed(3)}` : 'n/a',
            slStreak,
            timeoutRatio: timeoutRatio.toFixed(3),
            avgDurationSec: buyAgg || sellAgg ?
                ((buyAgg?.avgDurationMs ?? 0) + (sellAgg?.avgDurationMs ?? 0)) / (combinedCount || 1) / 1000 : 'n/a',
        });
    }

    /**
     * Safe average helper: computes the mean of an array of numbers.
     *
     * - Returns 0 if the array is empty (prevents division by zero / NaN)
     * - Handles undefined/null values gracefully by skipping them (via ?? 0)
     * - Used extensively in directional aggregate calculations
     *
     * @param values Array of numbers to average
     * @param defaultValue Value to return if array is empty (default: 0)
     * @returns The arithmetic mean, or defaultValue if empty
     */
    private safeAvg(values: number[], defaultValue: number = 0): number {
        if (!values || values.length === 0) {
            return defaultValue;
        }

        // Sum only valid numbers (extra safety, though mfe/mae/duration are validated upstream)
        const sum = values.reduce((acc, val) => acc + (val ?? 0), 0);

        return sum / values.length;
    }

    /**
 * Private helper: Prune (remove) old entries and enforce the maximum number of
 * completed simulations allowed per symbol (combined buy + sell).
 *
 * Called from:
 *   - addCompletedSimulation() — right after adding a new entry
 *   - cleanup() — during periodic maintenance on each symbol
 *
 * Responsibilities:
 *   A. Remove entries older than the recency window (this.recentWindowMs)
 *   B. If still exceeding maxClosedSims, keep only the newest ones
 *   C. Mutate the array in place (no return value)
 *
 * Invariants preserved:
 *   - Array remains sorted: newest first (index 0)
 *   - All remaining entries are within time window
 *   - Final length ≤ this.maxClosedSims
 *   - Safe & idempotent (multiple calls = no harm)
 *
 * @param entries Mutable array of CachedSimulationEntry[] for ONE symbol
 *                MUST be pre-sorted newest → oldest before calling
 * @param now Current timestamp (Date.now()) — injectable for testing
 */
    private _pruneEntries(entries: CachedSimulationEntry[], now: number): void {
        if (!entries || entries.length === 0) {
            return; // nothing to prune
        }

        // ── STEP 1: Remove old entries (reverse iteration for safe splice) ───────────
        const cutoff = now - this.recentWindowMs;
        let removedByTime = 0;

        for (let i = entries.length - 1; i >= 0; i--) {
            const entry = entries[i];

            // Defensive: skip if timestamp invalid/missing
            if (typeof entry.timestamp !== 'number' || entry.timestamp <= 0) {
                logger.warn('Invalid timestamp in cache entry – removing', {
                    symbol: 'N/A (prune)',
                    signalId: entry.signalId ?? 'unknown',
                    timestamp: entry.timestamp
                });
                entries.splice(i, 1);
                removedByTime++;
                continue;
            }

            if (entry.timestamp < cutoff) {
                entries.splice(i, 1);
                removedByTime++;

                if (logger.isDebugEnabled()) {
                    logger.debug('Pruned stale entry', {
                        signalId: entry.signalId,
                        direction: entry.direction,
                        ageHours: ((now - entry.timestamp) / (60 * 60 * 1000)).toFixed(1),
                        outcome: entry.outcome
                    });
                }
            }
        }

        // ── STEP 2: Enforce maximum total simulations (truncate oldest) ──────────────
        let removedByLimit = 0;

        if (entries.length > this.maxClosedSims) {
            removedByLimit = entries.length - this.maxClosedSims;

            logger.info('Enforcing maxClosedSims limit – truncating oldest', {
                before: entries.length,
                maxAllowed: this.maxClosedSims,
                removing: removedByLimit
            });

            // Slice keeps newest (since sorted newest → oldest)
            entries.length = this.maxClosedSims;
        }

        // ── STEP 3: Final logging & directional summary (for observability) ──────────
        const finalCount = entries.length;

        if (removedByTime > 0 || removedByLimit > 0) {
            // Count directions after prune (helps spot imbalances)
            const buyCount = entries.filter(e => e.direction === 'buy').length;
            const sellCount = entries.filter(e => e.direction === 'sell').length;

            logger.info('Prune completed', {
                removedByTime,
                removedByLimit,
                finalCount,
                buyCount,
                sellCount,
                withinWindow: finalCount === 0 || entries.every(e => e.timestamp >= cutoff),
                newestTimestamp: entries[0]?.timestamp ? new Date(entries[0].timestamp).toISOString() : 'none'
            });
        } else if (logger.isDebugEnabled()) {
            logger.debug('No pruning needed – entries valid', {
                count: finalCount,
                buyCount: entries.filter(e => e.direction === 'buy').length,
                sellCount: entries.filter(e => e.direction === 'sell').length
            });
        }

        // ── Optional debug assertion (only in dev/debug mode) ────────────────────────
        if (logger.isDebugEnabled()) {
            const allRecent = entries.every(e => e.timestamp >= cutoff);
            const lengthOk = entries.length <= this.maxClosedSims;
            if (!allRecent || !lengthOk) {
                logger.warn('Prune invariants violated – investigate', {
                    allWithinWindow: allRecent,
                    lengthOk,
                    finalCount: entries.length,
                    maxAllowed: this.maxClosedSims
                });
            }
        }
    }

    /**
 * Public read method: Retrieves the **full** excursion regime for a given symbol.
 *
 * Returns the richer regime object including:
 *   - Combined overview (total samples, SL streak, timeout ratio)
 *   - Directional aggregates (buy / sell) with MFE/MAE, ratio, durations, outcomes
 *   - Recent simulation history (`historyJson`) — newest first, capped for display
 *
 * When to use this vs `getRegimeLite`:
 *   - Need raw recent entries (debugging, alerts, detailed UI)
 *   - Need full directional breakdown for logging or analysis
 *
 * Performance:
 *   - O(1) most of the time (cached aggregates)
 *   - O(n) on cache miss (n ≤ maxClosedSims → fast)
 *
 * Edge cases:
 *   - No data → null
 *   - All entries pruned → null + cleanup
 *   - Cache miss → auto-recompute
 *
 * @param symbol Trading pair (e.g. 'BTC/USDT') — normalized internally
 * @returns ExcursionRegime or null if no recent completed simulations
 */
    public getRegime(symbol: string): ExcursionRegime | null {
        // ── STEP 1: Normalize symbol (consistent casing) ───────────────────────────────
        const normalized = symbol.trim().toUpperCase();
        if (!normalized) {
            logger.warn('getRegime called with invalid/empty symbol');
            return null;
        }

        // ── STEP 2: Fast path – return cached regime if available ──────────────────────
        let regime = this.aggregates.get(normalized);

        if (regime) {
            logger.debug('Returning cached full regime (fast path)', {
                symbol: normalized,
                totalSamples: regime.recentSampleCount,
                buySamples: regime.buy?.sampleCount ?? 0,
                sellSamples: regime.sell?.sampleCount ?? 0,
                slStreak: regime.slStreak,
                timeoutRatio: regime.timeoutRatio?.toFixed(3) ?? 'n/a',
                cachedAt: regime.updatedAt.toISOString(),
            });
            return regime;
        }

        // ── STEP 3: Check if we have raw entries to recompute from ─────────────────────
        const entries = this.cache.get(normalized);

        if (!entries || entries.length === 0) {
            // No data → clean up any stale aggregate and return null
            this.aggregates.delete(normalized);
            logger.debug('getRegime returning null – no simulation data', { symbol: normalized });
            return null;
        }

        // ── STEP 4: Cache miss – force recompute aggregates ────────────────────────────
        logger.debug('Cache miss on full regime – recomputing aggregates', {
            symbol: normalized,
            entryCount: entries.length,
            newest: entries[0]?.timestamp ? new Date(entries[0].timestamp).toISOString() : 'none',
            oldest: entries[entries.length - 1]?.timestamp
                ? new Date(entries[entries.length - 1].timestamp).toISOString()
                : 'none',
        });

        this.recomputeAggregates(normalized);

        // ── STEP 5: Retrieve fresh regime after recompute ──────────────────────────────
        regime = this.aggregates.get(normalized);

        if (!regime) {
            // Rare failure case – log error but don't crash
            logger.error('recomputeAggregates ran but no regime stored – possible bug', {
                symbol: normalized,
                entryCount: entries.length,
            });
            return null;
        }

        // ── STEP 6: Success logging (info level on miss) ───────────────────────────────
        logger.info('Full regime computed on cache miss and returned', {
            symbol: normalized,
            totalSamples: regime.recentSampleCount,
            buySamples: regime.buy?.sampleCount ?? 0,
            sellSamples: regime.sell?.sampleCount ?? 0,
            buyMfeMae: regime.buy ? `${regime.buy.mfe.toFixed(3)} / ${regime.buy.mae.toFixed(3)}` : 'n/a',
            sellMfeMae: regime.sell ? `${regime.sell.mfe.toFixed(3)} / ${regime.sell.mae.toFixed(3)}` : 'n/a',
            slStreak: regime.slStreak,
            timeoutRatio: regime.timeoutRatio?.toFixed(3) ?? 'n/a',
            avgDurationSec: regime.buy?.avgDurationMs || regime.sell?.avgDurationMs
                ? (((regime.buy?.avgDurationMs ?? 0) + (regime.sell?.avgDurationMs ?? 0)) /
                    (regime.recentSampleCount || 1) / 1000).toFixed(1)
                : 'n/a',
            computedAt: regime.updatedAt.toISOString(),
        });

        // ── STEP 7: Return the fresh regime ────────────────────────────────────────────
        return regime;
    }

    /**
 * Public read method: Retrieves the **lightweight** excursion regime for a given symbol.
 *
 * Optimized version without `historyJson` array — contains:
 *   - Combined overview (total samples, SL streak, timeout ratio)
 *   - Directional aggregates (`buy` / `sell`) with MFE/MAE, ratio, durations, outcomes
 *
 * Use this method when:
 *   - Performance matters (strategy loops, risk checks, alert decisions)
 *   - You only need summary stats (no raw simulation history)
 *   - Sending regime data over network or logging frequently
 *
 * Performance:
 *   - O(1) most of the time (cached aggregates)
 *   - O(n) on rare cache miss (n ≤ maxClosedSims → fast)
 *
 * Edge cases:
 *   - No data → null
 *   - Cache miss → auto-recompute
 *   - All entries pruned → null + cleanup
 *
 * @param symbol Trading pair (e.g. 'BTC/USDT') — normalized internally
 * @returns ExcursionRegimeLite or null if no recent completed simulations
 */
    public getRegimeLite(symbol: string): ExcursionRegimeLite | null {
        // ── STEP 1: Normalize symbol (consistent with other methods) ───────────────────
        const normalized = symbol.trim().toUpperCase();
        if (!normalized) {
            logger.warn('getRegimeLite called with invalid/empty symbol');
            return null;
        }

        // ── STEP 2: Fast path — return cached lightweight regime ───────────────────────
        let regime = this.aggregates.get(normalized);

        if (regime) {
            // Destructure to exclude historyJson (lightweight by design)
            const { historyJson, ...liteRegime } = regime;

            logger.debug('Returning cached lightweight regime (fast path)', {
                symbol: normalized,
                totalSamples: liteRegime.recentSampleCount,
                buySamples: liteRegime.buy?.sampleCount ?? 0,
                sellSamples: liteRegime.sell?.sampleCount ?? 0,
                slStreak: liteRegime.slStreak,
                timeoutRatio: liteRegime.timeoutRatio?.toFixed(3) ?? 'n/a',
                cachedAt: liteRegime.updatedAt.toISOString(),
            });

            return liteRegime as ExcursionRegimeLite;
        }

        // ── STEP 3: No cache hit — check if raw entries exist ──────────────────────────
        const entries = this.cache.get(normalized);

        if (!entries || entries.length === 0) {
            // No data → clean up aggregate reference and return null
            this.aggregates.delete(normalized);
            logger.debug('getRegimeLite returning null – no simulation data', {
                symbol: normalized,
            });
            return null;
        }

        // ── STEP 4: Cache miss with entries → force recompute ──────────────────────────
        logger.debug('Cache miss on lightweight regime – recomputing aggregates', {
            symbol: normalized,
            entryCount: entries.length,
            newest: entries[0]?.timestamp ? new Date(entries[0].timestamp).toISOString() : 'none',
        });

        this.recomputeAggregates(normalized);

        // ── STEP 5: Retrieve fresh regime after recompute ──────────────────────────────
        regime = this.aggregates.get(normalized);

        if (!regime) {
            // Rare failure — log but return null safely
            logger.error('recomputeAggregates ran but no regime stored – possible bug', {
                symbol: normalized,
                entryCount: entries.length,
            });
            return null;
        }

        // ── STEP 6: Create lightweight version (exclude historyJson) ───────────────────
        const { historyJson, ...liteRegime } = regime;

        // ── STEP 7: Log success on cache miss (info level) ─────────────────────────────
        logger.info('Lightweight regime computed on cache miss and returned', {
            symbol: normalized,
            totalSamples: liteRegime.recentSampleCount,
            buySamples: liteRegime.buy?.sampleCount ?? 0,
            sellSamples: liteRegime.sell?.sampleCount ?? 0,
            buyMfeMae: liteRegime.buy ? `${liteRegime.buy.mfe.toFixed(3)} / ${liteRegime.buy.mae.toFixed(3)}` : 'n/a',
            sellMfeMae: liteRegime.sell ? `${liteRegime.sell.mfe.toFixed(3)} / ${liteRegime.sell.mae.toFixed(3)}` : 'n/a',
            slStreak: liteRegime.slStreak,
            timeoutRatio: liteRegime.timeoutRatio?.toFixed(3) ?? 'n/a',
            avgDurationSec: (liteRegime.buy?.avgDurationMs ?? 0) || (liteRegime.sell?.avgDurationMs ?? 0)
                ? (((liteRegime.buy?.avgDurationMs ?? 0) + (liteRegime.sell?.avgDurationMs ?? 0)) /
                    (liteRegime.recentSampleCount || 1) / 1000).toFixed(1)
                : 'n/a',
            computedAt: liteRegime.updatedAt.toISOString(),
        });

        // ── STEP 8: Return lightweight regime ──────────────────────────────────────────
        return liteRegime;
    }

    /**
     * Warms up the in-memory excursion cache from the database on startup.
     *
     * Purpose:
     *   - After bot restart, restore recent simulation history so regime advice,
     *     scoring, and ML features work immediately (no cold start)
     *   - Loads only **labeled + closed** simulations (ready for training)
     *   - Respects the same limits as normal operation (last N hours + max 10 per symbol)
     *   - Reuses `addCompletedSimulation()` so scoring, label mapping, pruning,
     *     and aggregate recomputation happen automatically
     *
     * When to call:
     *   - Once during application startup (after dbService.initialize())
     *   - Optionally on a schedule (e.g. every 30–60 minutes) for safety
     *
     * @param recencyHours - How far back to load (default = RECENT_WINDOW_HOURS_DEFAULT)
     */
    public async warmUpFromDb(recencyHours: number = RECENT_WINDOW_HOURS_DEFAULT): Promise<void> {
        const cutoffTime = Date.now() - recencyHours * 60 * 60 * 1000;

        try {
            logger.info(`=== Starting cache warm-up from database ===`);
            logger.info(`Loading labeled simulations from last ${recencyHours} hours...`);

            // 1. Fetch recent labeled + closed simulations from DB
            const recentSims = await dbService.getRecentLabeledSimulations(cutoffTime);

            if (recentSims.length === 0) {
                logger.info('No recent labeled simulations found in DB – cache will start empty');
                return;
            }

            logger.info(`Found ${recentSims.length} recent labeled simulations in DB`);

            // 2. Group by symbol and keep only the newest MAX_CLOSED_SIMS_PER_SYMBOL per symbol
            const bySymbol = new Map<string, SimulatedTrade[]>();

            for (const row of recentSims) {
                if (!bySymbol.has(row.symbol)) {
                    bySymbol.set(row.symbol, []);
                }

                const arr = bySymbol.get(row.symbol)!;
                if (arr.length < MAX_CLOSED_SIMS_PER_SYMBOL) {
                    arr.push(row);
                }
            }

            // 3. Convert DB rows → cache entries and add them
            let totalLoaded = 0;

            for (const [symbol, sims] of bySymbol) {
                for (const sim of sims) {
                    // Build full cache entry (must match CachedSimulationEntry)
                    const cacheEntry: CachedSimulationEntry = {
                        signalId: sim.signalId,
                        timestamp: sim.closedAt!,           // use closedAt as completion time
                        direction: sim.side as 'buy' | 'sell',
                        outcome: sim.outcome! as SimulationOutcome,
                        rMultiple: (sim.rMultiple ?? 0) / 10000,   // unscale from DB
                        label: sim.label! as SignalLabel,
                        mfe: (sim.maxFavorableExcursion ?? 0) / 1e8,
                        mae: (sim.maxAdverseExcursion ?? 0) / 1e8,
                        durationMs: sim.durationMs ?? 0,
                        timeToMFE_ms: sim.timeToMFEMs ?? 0,
                        timeToMAE_ms: sim.timeToMAEMs ?? 0,
                    };

                    // Add to cache → this will compute score, label, prune, and recompute aggregates
                    this.addCompletedSimulation(symbol, cacheEntry);

                    totalLoaded++;
                }
            }

            // 4. Final summary
            logger.info(`Cache warm-up completed successfully`, {
                symbolsLoaded: bySymbol.size,
                totalSimulationsLoaded: totalLoaded,
                recencyHours,
                cutoffTime: new Date(cutoffTime).toISOString(),
            });

        } catch (err) {
            logger.error('Cache warm-up from database FAILED', {
                error: err instanceof Error ? err.message : String(err),
                stack: err instanceof Error ? err.stack : undefined,
            });
            // Continue startup with empty cache — better than crashing the bot
        }
    }

    /**
 * Public method: Periodic global cleanup – enforces time-based expiration and maximum entry limits
 * across **all symbols** in the cache.
 *
 * This method is called automatically every ~30 minutes via setInterval in the constructor.
 * Its job is to keep memory usage bounded over long-running periods and prevent accumulation
 * of ancient or excessive data.
 *
 * Responsibilities in strict order:
 *   1. Loop over EVERY symbol currently in the cache
 *   2. For each symbol:
 *      - Call _pruneEntries() to remove anything older than the recency window (~6 hours)
 *      - If after pruning the array is empty → delete the symbol entirely (cache + aggregates)
 *      - If entries were removed → trigger recomputeAggregates() so stats stay accurate
 *   3. Log a summary of what was pruned (only if anything actually changed)
 *
 * Important design invariants this method must preserve:
 *   - After cleanup, every remaining entry is within the time window
 *   - No symbol has more than maxClosedSims (5) entries
 *   - Aggregates are fresh for any symbol that was modified
 *   - Safe to call multiple times (idempotent — second call does almost nothing)
 *   - No live entries exist anyway (we reject them at write time)
 *   - Does NOT touch symbols that have zero entries (they're already gone)
 *
 * Performance notes:
 *   - O(total_entries_across_all_symbols) — usually very small (dozens to hundreds)
 *   - Worst case: hundreds of symbols × 5 entries = still fast (<1ms)
 *   - No heavy allocations or sorting (pruning is reverse iteration + splice)
 *
 * When this runs:
 *   - Automatically every cleanupIntervalMs (30 min default)
 *   - Optionally manually during heavy load, before shutdown, or for debugging
 *
 * Logging:
 *   - Debug level when nothing happens
 *   - Info level when pruning actually occurs (with counts)
 *   - No error throwing — fails gracefully
 */
    public cleanup(): void {
        // ── STEP 1: Early exit if cache is completely empty ──────────────────────────
        // No symbols → nothing to clean
        if (this.cache.size === 0) {
            logger.debug('cleanup() called but cache is empty — nothing to do');
            return;
        }

        const startTime = Date.now();
        const now = startTime; // consistent timestamp for this whole pass

        let totalPrunedByTime = 0;
        let symbolsAffected = 0;
        let symbolsDeleted = 0;

        logger.debug('Starting periodic global cleanup', {
            currentSymbols: this.cache.size,
            currentTotalEntries: Array.from(this.cache.values()).reduce((sum, arr) => sum + arr.length, 0),
            cutoffTime: new Date(now - this.recentWindowMs).toISOString(),
            maxPerSymbol: this.maxClosedSims,
        });

        // ── STEP 2: Iterate over ALL symbols in the cache ────────────────────────────
        // We use for...of on entries() so we can safely delete during iteration
        for (const [symbol, entries] of this.cache.entries()) {
            const beforeCount = entries.length;

            if (beforeCount === 0) {
                // Should never happen — but defensive cleanup
                this.cache.delete(symbol);
                this.aggregates.delete(symbol);
                continue;
            }

            // ── 2a: Enforce time window + max limit on this symbol ───────────────────
            // This mutates entries in place
            this._pruneEntries(entries, now);

            const afterPruneCount = entries.length;

            // Count what happened
            const prunedThisSymbol = beforeCount - afterPruneCount;

            if (prunedThisSymbol > 0) {
                totalPrunedByTime += prunedThisSymbol;
                symbolsAffected++;
            }

            // ── 2b: Handle empty symbol after pruning ────────────────────────────────
            if (afterPruneCount === 0) {
                this.cache.delete(symbol);
                this.aggregates.delete(symbol);
                symbolsDeleted++;
                logger.debug('Symbol fully deleted after time pruning', { symbol });
                continue;
            }

            // ── 2c: If we removed anything → recompute aggregates for freshness ──────
            if (prunedThisSymbol > 0) {
                this.recomputeAggregates(symbol);

                logger.debug('Recomputed aggregates after pruning', {
                    symbol,
                    before: beforeCount,
                    after: afterPruneCount,
                    removed: prunedThisSymbol,
                });
            }
        }

        // ── STEP 3: Final summary logging (only meaningful if something happened) ─────
        const durationMs = Date.now() - startTime;
        const remainingSymbols = this.cache.size;
        const remainingEntries = Array.from(this.cache.values()).reduce((sum, arr) => sum + arr.length, 0);

        if (totalPrunedByTime > 0 || symbolsDeleted > 0) {
            logger.info('Periodic cleanup completed — data was pruned', {
                prunedByTimeWindow: totalPrunedByTime,
                symbolsAffectedByPrune: symbolsAffected,
                symbolsFullyDeleted: symbolsDeleted,
                remainingSymbols,
                remainingTotalEntries: remainingEntries,
                durationMs: durationMs.toFixed(1),
                maxPerSymbolEnforced: this.maxClosedSims,
            });
        } else {
            logger.debug('Periodic cleanup completed — no pruning needed', {
                symbolsChecked: this.cache.size,
                totalEntries: remainingEntries,
                durationMs: durationMs.toFixed(1),
            });
        }

        // ── End of cleanup ───────────────────────────────────────────────────────────
        // Cache is now bounded:
        //   - No entry older than ~6 hours
        //   - No symbol has >5 entries
        //   - Aggregates are up-to-date for any modified symbol
    }

    /**
     * Public method: Graceful shutdown and resource cleanup for the ExcursionHistoryCache.
     *
     * This method should be called exactly once during application shutdown — typically in:
     *   - Main process exit handler (process.on('SIGTERM'), 'SIGINT'))
     *   - Container stop hook (Docker/Kubernetes graceful termination)
     *   - Worker shutdown sequence (e.g. when stopping the MarketScanner or entire bot)
     *
     * Responsibilities in strict order:
     *   1. Prevent double-shutdown (idempotent — safe to call multiple times)
     *   2. Stop the periodic cleanup timer (prevents new background tasks after shutdown)
     *   3. Perform one final cleanup pass → ensures latest state is pruned & aggregates fresh
     *   4. Log shutdown status clearly (helps confirm clean exit in logs/monitoring)
     *   5. Do NOT clear the actual cache data by default — let Node.js GC handle memory
     *      (this keeps memory alive until process fully exits — usually desired)
     *
     * Important design principles:
     *   - **Idempotent**: Calling destroy() twice does nothing the second time
     *   - **Fail-safe**: Never throws — errors are logged but shutdown continues
     *   - **Observability**: Detailed logging at info/debug levels
     *   - **No persistence**: We don't flush to disk/DB (if needed, add later)
     *   - **Minimal work**: Fast execution — should not delay process exit
     *
     * When NOT to call this:
     *   - During normal operation (timer should keep running)
     *   - In tests (unless you want to simulate shutdown)
     *
     * Future optional extensions (commented out for now):
     *   - Final stats export / Prometheus push
     *   - Cache snapshot for warm restart
     *   - Event emission (if we add listeners later)
     *
     * Typical usage pattern in main app:
     *
     * ```ts
     * process.on('SIGTERM', () => {
     *   logger.info('SIGTERM received — initiating graceful shutdown...');
     *   excursionCache.destroy();
     *   // other shutdown steps...
     *   process.exit(0);
     * });
     * ```
     */
    public destroy(): void {
        // ── STEP 1: Idempotency check — prevent double execution ─────────────────────
        // If timer is already null → we've already been called (or never started)
        if (!this.cleanupTimer) {
            logger.debug('destroy() called but cleanup timer already stopped — idempotent no-op', {
                alreadyDestroyed: true,
                timestamp: new Date().toISOString(),
            });
            return;
        }

        // ── STEP 2: Stop the periodic background cleanup timer ───────────────────────
        // This prevents any new cleanup tasks from starting after we begin shutdown
        clearInterval(this.cleanupTimer);
        this.cleanupTimer = null;

        logger.info('ExcursionHistoryCache background cleanup timer stopped', {
            shutdownTime: new Date().toISOString(),
            previousIntervalMs: this.cleanupIntervalMs,
        });

        // ── STEP 3: Perform one final cleanup pass ───────────────────────────────────
        // This ensures:
        //   - All old entries are pruned one last time
        //   - Aggregates are fresh for any symbol that still has data
        //   - We have accurate final stats before process exit
        try {
            logger.debug('Performing final cleanup pass during shutdown...');

            const startFinal = Date.now();
            this.cleanup(); // re-uses the same logic as periodic cleanup

            const finalDurationMs = Date.now() - startFinal;

            // ── STEP 4: Log final cache state for observability ──────────────────────
            // Very useful in production to confirm clean shutdown
            const finalStats = {
                remainingSymbols: this.cache.size,
                remainingTotalEntries: Array.from(this.cache.values()).reduce((sum, arr) => sum + arr.length, 0),
                remainingAggregates: this.aggregates.size,
                durationMs: finalDurationMs.toFixed(1),
                memoryPressureEstimate: this.cache.size > 100 ||
                    Array.from(this.cache.values()).reduce((sum, arr) => sum + arr.length, 0) > 500
                    ? 'high'
                    : 'normal',
            };

            logger.info('Final cleanup pass completed during shutdown', finalStats);

            // Optional: more detailed breakdown if debug enabled
            if (logger.isDebugEnabled() && finalStats.remainingSymbols > 0) {
                logger.debug('Final remaining symbols summary', {
                    symbolCount: finalStats.remainingSymbols,
                    totalEntries: finalStats.remainingTotalEntries,
                    activeAggregates: finalStats.remainingAggregates,
                    examples: Array.from(this.cache.keys()).slice(0, 3), // first few symbols
                });
            }
        } catch (err) {
            // ── STEP 5: Handle errors gracefully — never block shutdown ──────────────
            // Even if cleanup throws (unlikely), we must continue exit
            logger.error('Error during final cleanup pass in destroy()', {
                errorMessage: err instanceof Error ? err.message : String(err),
                stack: err instanceof Error ? err.stack : undefined,
                shutdownContinues: true,
            });
        }

        // ── STEP 6: Final shutdown confirmation ──────────────────────────────────────
        // Clear signal that we're done — safe for process to exit now
        logger.info('ExcursionHistoryCache destroy complete — ready for process exit', {
            timestamp: new Date().toISOString(),
            finalCacheSize: this.cache.size,
            finalAggregateCount: this.aggregates.size,
        });

        // ── End of destroy ───────────────────────────────────────────────────────────
        // No more cleanup timer will run
        // Memory will be freed naturally by Node.js when process exits
    }

    // ──────────────────────────────────────────────────────────────────────────────
    // Static utilities – unchanged for now (can be stubbed/refactored later)
    // ──────────────────────────────────────────────────────────────────────────────
    /**
  * Static utility method: Computes the **excursion ratio** — a core risk/reward efficiency metric.
  *
  * Formula:
  *   excursionRatio = MFE / |MAE|
  *
  * Interpretation guide (for percentage-based excursions):
  *   > 2.0     → Excellent regime — strong reward vs risk (favor this direction)
  *   1.5–2.0   → Good — meaningful edge
  *   1.0–1.5   → Balanced — reward roughly matches risk
  *   0.5–1.0   → Weak — more pain than gain (caution / possible skip)
  *   < 0.5     → Poor — drawdowns dominate (strong skip or reverse candidate)
  *   0         → No meaningful ratio (insufficient data or zero MAE)
  *
  * Safety features:
  *   - Returns 0 on invalid/meaningless inputs (zero/negative MFE, zero MAE)
  *   - Protects against tiny MAE values causing huge ratios
  *   - Caps extreme ratios to prevent downstream numeric issues
  *   - Pure function — no side effects, safe to call anywhere
  *
  * @param mfe Maximum Favorable Excursion (should be ≥ 0)
  * @param mae Maximum Adverse Excursion (should be ≤ 0)
  * @returns Safe excursion ratio (≥ 0)
  *          - 0 when ratio cannot be meaningfully computed
  *          - Positive value indicating historical reward-to-risk efficiency
  *
  * @example
  * computeExcursionRatio(2.8, -0.9)   // → ~3.11  (excellent)
  * computeExcursionRatio(1.2, -2.5)   // → 0.48   (poor — caution)
  * computeExcursionRatio(5.0, 0)      // → 0      (no drawdown = undefined)
  * computeExcursionRatio(0, -1.0)     // → 0      (no favorable movement)
  * computeExcursionRatio(-0.5, -1.0)  // → 0      (invalid negative MFE)
  */
    public static computeExcursionRatio(mfe: number, mae: number): number {
        // ── Configurable thresholds (can be moved to class constants later) ───────────
        const MIN_MAE_THRESHOLD = 1e-6;       // Ignore tiny MAE values (noise protection)
        const MAX_REASONABLE_RATIO = 50;      // Cap extreme ratios (e.g. 100× in pumps)

        // ── STEP 1: Reject invalid / meaningless MFE ────────────────────────────────
        if (mfe <= 0) {
            if (logger.isDebugEnabled() && mfe < 0) {
                logger.debug('computeExcursionRatio: negative MFE treated as 0', {
                    mfe,
                    mae,
                    result: 0
                });
            }
            return 0;
        }

        // ── STEP 2: Handle zero or near-zero MAE (no drawdown) ──────────────────────
        const absMae = Math.abs(mae);

        if (absMae === 0 || absMae < MIN_MAE_THRESHOLD) {
            if (logger.isDebugEnabled()) {
                logger.debug('computeExcursionRatio: insignificant MAE — returning 0', {
                    mae,
                    absMae,
                    minThreshold: MIN_MAE_THRESHOLD,
                    mfe
                });
            }
            return 0;
        }

        // ── STEP 3: Core calculation ────────────────────────────────────────────────
        let ratio = mfe / absMae;

        // ── STEP 4: Safety cap for extreme values ───────────────────────────────────
        if (ratio > MAX_REASONABLE_RATIO) {
            logger.debug('Excursion ratio capped for numeric stability', {
                rawRatio: ratio,
                cappedTo: MAX_REASONABLE_RATIO,
                mfe,
                absMae
            });
            ratio = MAX_REASONABLE_RATIO;
        }

        // ── STEP 5: Return clean positive value ─────────────────────────────────────
        return ratio;
    }

    /**
 * Static utility method: Converts an absolute excursion value (in quote currency units)
 * into a **percentage change** relative to the trade's entry price.
 *
 * Formula:
 *   percentage = (value / entryPrice) × 100
 *
 * Purpose & usage:
 *   - Normalize MFE (Maximum Favorable Excursion) and MAE (Maximum Adverse Excursion)
 *     so they are comparable across symbols with very different price scales
 *   - Used in aggregation, advice generation, alerts, ML features, etc.
 *   - Positive result → favorable movement (profit direction)
 *   - Negative result → adverse movement (loss/drawdown direction)
 *
 * Key safety & robustness features:
 *   - Prevents division by zero or negative entry price → returns 0
 *   - Handles NaN, Infinity, extremely small/large values gracefully
 *   - Applies reasonable bounds (-10000% to +10000%) to avoid numeric explosions
 *     in downstream logic (crypto can have 100× pumps/dumps)
 *   - In production: always returns safe 0 on invalid input (fail-open)
 *   - In dev/test: throws on obviously invalid entryPrice (catches bugs early)
 *
 * Why this exists as static:
 *   - Pure function — no instance dependency
 *   - Reusable anywhere (cache, strategy, utils, ML pipeline)
 *   - Single source of truth for how percentage excursions are calculated
 *
 * @param value      - Absolute excursion in quote currency
 *                       Positive = favorable (MFE)
 *                       Negative = adverse (MAE)
 * @param entryPrice - The entry price of the trade (must be > 0)
 * @returns Percentage excursion relative to entry price
 *          e.g. +2.5  → +2.5% favorable
 *               -1.8  → -1.8% adverse
 *               0     → no movement or invalid input
 *
 * @example
 * normalizeExcursion(1500, 60000)   // → +2.5     ($1500 profit on $60k entry = +2.5%)
 * normalizeExcursion(-900, 45000)   // → -2.0     (-$900 drawdown = -2%)
 * normalizeExcursion(0, 100)        // → 0
 * normalizeExcursion(200, 0)        // → 0 (invalid entry price)
 * normalizeExcursion(5000, 0.0001)  // → +5000000 (capped to +10000)
 * normalizeExcursion(-1e10, 100)    // → -10000   (capped)
 */
    public static normalizeExcursion(value: number, entryPrice: number): number {
        // ── STEP 1: Input validation – protect against invalid entry price ───────────
        // Entry price ≤ 0 is mathematically invalid and dangerous
        if (entryPrice <= 0 || isNaN(entryPrice) || !isFinite(entryPrice)) {
            // In development/testing: throw early to catch bugs
            if (process.env.NODE_ENV !== 'production') {
                throw new Error(
                    `normalizeExcursion: invalid entryPrice ${entryPrice} ` +
                    `(must be positive finite number)`
                );
            }

            // In production: fail-safe → return 0 (better than NaN/Infinity downstream)
            logger.warn('normalizeExcursion called with invalid entryPrice', {
                entryPrice,
                value,
                context: 'production safety fallback → returning 0',
            });

            return 0;
        }

        // ── STEP 2: Zero movement case – early return for efficiency ─────────────────
        // Most common trivial case — skip all math
        if (value === 0 || isNaN(value) || !isFinite(value)) {
            return 0;
        }

        // ── STEP 3: Core calculation – standard percentage change formula ───────────
        const percentage = (value / entryPrice) * 100;

        // ── STEP 4: Apply reasonable bounds to prevent numeric insanity ─────────────
        // Crypto can have extreme moves (100× pumps or dumps in minutes)
        // But ratios > 10000% or < -10000% usually indicate data errors or outliers
        // We clamp to protect downstream logic (multipliers, comparisons, alerts)
        const MIN_SAFE_PCT = -10000;  // -100× entry price
        const MAX_SAFE_PCT = 10000;   // +100× entry price

        const boundedPercentage = Math.max(MIN_SAFE_PCT, Math.min(MAX_SAFE_PCT, percentage));

        // ── STEP 5: Log when bounding occurs (debug only) ────────────────────────────
        // Helps detect data issues (bad candles, exchange glitches, misreported prices)
        if (boundedPercentage !== percentage && logger.isDebugEnabled()) {
            logger.debug('Excursion percentage was bounded for safety', {
                originalPct: percentage.toFixed(4),
                boundedPct: boundedPercentage.toFixed(4),
                entryPrice,
                rawValue: value,
                reason: percentage > MAX_SAFE_PCT ? 'extreme positive' : 'extreme negative',
            });
        }

        // ── STEP 6: Return final safe value ──────────────────────────────────────────
        return boundedPercentage;
    }

    /**
 * Static utility method: Determines whether the current regime shows **dangerously high drawdown risk**
 * in the requested trade direction (long or short).
 *
 * Critical safety filter used in:
 *   - Strategy.generateSignal() — to skip/demote signals
 *   - getExcursionAdvice() — to force 'skip' or tighten levels
 *   - AutoTradeService — to block/reduce live trades
 *   - Alerts — to show red flags
 *
 * 2026+ pure directional rules:
 *   1. Require minimum trusted samples **strictly on the intended side** (default 3)
 *   2. Use **only directional MAE** from buy or sell aggregates
 *   3. No fallback to combined MAE — if side missing or insufficient samples → treat as safe
 *   4. Compare |MAE| against configurable threshold (default 3.0%)
 *
 * Returns:
 *   true  → High drawdown risk on this side → skip / reduce size / warn
 *   false → Acceptable risk, or insufficient side data to judge → proceed (or skip upstream)
 *
 * Safety:
 *   - Fail-open on missing/insufficient side data → false
 *   - Never throws — always returns boolean
 *   - Pure directional — no combined stats used for risk judgment
 *
 * Config:
 *   - maxMaePct → config.strategy.maxMaePct (default 3.0)
 *   - minSamples → config.strategy.minExcursionSamples (default 3)
 *
 * @param regime Full or lite ExcursionRegime from cache
 * @param direction 'long' (buy) or 'short' (sell)
 * @returns boolean — true if drawdown risk is dangerously high **on this side**
 */
    public static isHighMaeRisk(
        regime: ExcursionRegime | ExcursionRegimeLite | null | undefined,
        direction: LongShort
    ): boolean {
        // ── STEP 1: Early guard — invalid/missing regime → treat as safe ───────────────
        if (!regime || typeof regime !== 'object') {
            logger.debug('isHighMaeRisk: invalid/missing regime — treated as safe', {
                regimeType: regime === null ? 'null' : typeof regime,
                direction
            });
            return false;
        }

        // ── STEP 2: Configuration (centralized, overridable) ───────────────────────────
        const MAX_MAE_PCT_DEFAULT = 3.0;          // 3% avg drawdown = danger zone
        const MIN_SAMPLES_FOR_TRUST = 3;          // strict minimum for directional trust

        const maxMaePct = config.strategy?.maxMaePct ?? MAX_MAE_PCT_DEFAULT;
        const minSamples = config.strategy?.minExcursionSamples ?? MIN_SAMPLES_FOR_TRUST;

        // ── STEP 3: Strict directional check — no combined fallback ─────────────────────
        const isLong = direction === 'long';
        const sideAgg = isLong ? regime.buy : regime.sell;

        // Use strict directional sample check (no combined fallback)
        const hasEnoughSide = ExcursionHistoryCache.hasEnoughSamples(regime, minSamples, direction);

        if (!hasEnoughSide) {
            // Side missing or insufficient samples → cannot judge risk → treat as safe
            logger.debug('isHighMaeRisk: insufficient directional samples — treated as safe', {
                symbol: regime.symbol,
                direction,
                sideSamples: sideAgg?.sampleCount ?? 0,
                requiredMin: minSamples
            });
            return false;
        }

        // ── STEP 4: Use only directional MAE — no averaging or combined fallback ────────
        const mae = sideAgg?.mae;

        if (mae === undefined || mae === 0) {
            logger.debug('isHighMaeRisk: no usable directional MAE — treated as safe', {
                symbol: regime.symbol,
                direction,
                sideSamples: sideAgg?.sampleCount ?? 0
            });
            return false;
        }

        // ── STEP 5: Core risk decision — absolute drawdown vs threshold ─────────────────
        const absMae = Math.abs(mae);
        const isHighRisk = absMae > maxMaePct;

        // ── STEP 6: Detailed debug log only when risk is actually high ──────────────────
        if (isHighRisk && logger.isDebugEnabled()) {
            logger.debug('High MAE risk DETECTED (pure directional)', {
                symbol: regime.symbol,
                direction,
                maeValue: mae.toFixed(3),
                absMae: absMae.toFixed(3),
                threshold: maxMaePct,
                sideSamples: sideAgg?.sampleCount,
                slStreakSide: isLong ? regime.slStreakBuy : regime.slStreakSell,
                outcomeSl: sideAgg?.outcomeCounts.sl
            });
        }

        // ── STEP 7: Final result ────────────────────────────────────────────────────────
        return isHighRisk;
    }

    /**
     * Static utility method: Determines whether we have **enough completed simulation samples**
     * to reasonably trust the regime statistics (MFE/MAE, ratio, outcomes, durations, streaks...).
     *
     * Critical confidence gate used in:
     *   - getExcursionAdvice() — to trust side-specific data or force 'skip'
     *   - Strategy.generateSignal() — to reduce confidence / add warnings on sparse data
     *   - AutoTradeService — to gate trades/alerts on low-sample symbols
     *   - Alerts/UI — to show "limited data" disclaimers
     *
     * 2026+ pure directional rules:
     *   - When direction is provided → **strictly** check side-specific sample count (buy/sell)
     *     → No fallback to combined count allowed — if side is missing or insufficient → not trusted
     *   - When no direction is provided → use combined recentSampleCount (only for alert gate)
     *   - Conservative: better "not enough data" than trust noisy/sparse side stats
     *   - Only completed simulations count (no live blending)
     *
     * Configurability:
     *   - Default minSamples = config.strategy.minExcursionSamples ?? 3
     *   - Caller can override (e.g. stricter for live trades)
     *
     * Returns:
     *   true  → Enough trusted samples on the relevant side (or combined if no direction)
     *   false → Too few → be cautious (skip, lower conf, warn, etc.)
     *
     * @param regime Full or lite ExcursionRegime from cache
     * @param minSamples Optional override for minimum trusted samples (default from config)
     * @param direction Optional: 'long' or 'short' — if provided, checks **side-specific** count only (no fallback)
     * @returns boolean — true if we can trust the regime stats
     *
     * @example
     * hasEnoughSamples(regime)                        // true if combined >= 3 (alert gate only)
     * hasEnoughSamples(regime, 3, 'long')             // true only if regime.buy?.sampleCount >= 3
     * hasEnoughSamples(regime, 3, 'short')            // true only if regime.sell?.sampleCount >= 3
     * hasEnoughSamples(regime)                        // false if combined < 3
     * hasEnoughSamples(undefined)                     // false (defensive)
     */
    public static hasEnoughSamples(
        regime: ExcursionRegime | ExcursionRegimeLite | null | undefined,
        minSamples: number = MIN_SAMPLES_FOR_TRUST_DEFAULT,
        direction?: LongShort
    ): boolean {
        // ── STEP 1: Input safety — fail-safe on invalid/missing regime ─────────────────────────
        if (!regime || typeof regime !== 'object') {
            logger.debug('hasEnoughSamples: invalid/missing regime — treated as insufficient', {
                regimeType: regime === null ? 'null' : typeof regime,
                minSamples,
                direction: direction ?? 'none'
            });
            return false;
        }

        // ── STEP 2: Normalize minSamples (prevent bad caller input) ────────────────────
        const effectiveMin = Math.max(1, Math.floor(minSamples));

        // ── STEP 3: Handle no-direction case (reserved for alert gate only) ─────────────
        if (!direction) {
            const combinedCount = regime.recentSampleCount ?? 0;
            const hasEnoughCombined = combinedCount >= effectiveMin;

            if (logger.isDebugEnabled() && combinedCount > 0 && combinedCount < effectiveMin + 4) {
                logger.debug('Borderline combined sample count (alert gate)', {
                    symbol: regime.symbol ?? 'unknown',
                    combinedSamples: combinedCount,
                    required: effectiveMin,
                    decision: hasEnoughCombined ? 'trusted for alert' : 'not trusted'
                });
            }

            return hasEnoughCombined;
        }

        // ── STEP 4: Pure directional check – NO combined fallback allowed ───────────────
        const isLong = direction === 'long';
        const sideAgg = isLong ? regime.buy : regime.sell;
        const sideCount = sideAgg?.sampleCount ?? 0;

        const hasEnough = sideCount >= effectiveMin;

        // ── STEP 5: Borderline debug logging (helps tuning minSamples & side coverage) ──
        if (logger.isDebugEnabled() && sideCount > 0 && sideCount < effectiveMin + 4) {
            logger.debug('Borderline directional sample count', {
                symbol: regime.symbol ?? 'unknown',
                direction,
                sideSamples: sideCount,
                required: effectiveMin,
                decision: hasEnough ? 'trusted' : 'not trusted – skip required',
                oppositeSideSamples: isLong
                    ? regime.sell?.sampleCount ?? 0
                    : regime.buy?.sampleCount ?? 0
            });
        }

        // ── STEP 6: Return clean boolean – strict side-only result ──────────────────────
        return hasEnough;
    }
}

// Singleton export
export const excursionCache = new ExcursionHistoryCache();
