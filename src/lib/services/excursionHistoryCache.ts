// src/lib/services/excursionHistoryCache.ts
// =============================================================================
// EXCURSION HISTORY CACHE – CENTRALIZED SOURCE OF TRUTH FOR SIMULATION METRICS
//
// Fresh 2025 implementation:
//   • Focused exclusively on completed simulations (no live tracking)
//   • Max 5 most recent completed simulations per symbol (after time pruning)
//   • Configurable 6-hour recency window
//   • Enriched with outcome counts, directional outcomes, SL streak, timeout ratio
//   • Aggregates recomputed on write + during periodic cleanup
// =============================================================================

import { createLogger } from '../logger';
import { config } from '../config/settings';
import type { SimulationHistoryEntry } from '../../types/signalHistory';

const logger = createLogger('ExcursionCache');

// ──────────────────────────────────────────────────────────────────────────────
// Configuration constants (overridable via config)
// ──────────────────────────────────────────────────────────────────────────────

const RECENT_WINDOW_HOURS_DEFAULT = 6;
const MAX_CLOSED_SIMS_PER_SYMBOL = 5;
const MIN_SAMPLES_FOR_TRUST_DEFAULT = 2;

/**
 * Cached entry – strictly for completed simulations only
 */
interface CachedSimulationEntry extends SimulationHistoryEntry {
    signalId: string;
    timestamp: number;     // completion timestamp
    lastUpdated: number;   // matches timestamp for completed
    direction: 'buy' | 'sell';
}

/**
 * Full regime – includes capped history + outcome-enriched aggregates
 */
export interface ExcursionRegime {
    symbol: string;
    historyJson?: SimulationHistoryEntry[]; // newest first, max 5

    // Core aggregates from recent completed simulations
    recentAvgR: number;
    recentWinRate: number;
    recentReverseCount: number;
    recentMae: number;           // ≤ 0
    recentMfe: number;           // ≥ 0
    recentExcursionRatio: number;
    recentSampleCount: number;

    // Directional aggregates (completed only)
    recentMfeLong?: number;
    recentMaeLong?: number;
    recentSampleCountLong?: number;

    recentMfeShort?: number;
    recentMaeShort?: number;
    recentSampleCountShort?: number;

    // Outcome statistics (new)
    outcomeCounts: {
        tp: number;
        partial_tp: number;
        sl: number;
        timeout: number;
    };
    outcomeCountsLong?: {
        tp: number;
        partial_tp: number;
        sl: number;
        timeout: number;
    };
    outcomeCountsShort?: {
        tp: number;
        partial_tp: number;
        sl: number;
        timeout: number;
    };

    slStreak: number;           // consecutive SL from newest entry
    timeoutRatio: number;       // timeoutCount / total (0–1)

    activeCount: 0;             // permanently 0 – no live simulations

    updatedAt: Date;
}

/**
 * Lightweight version – no historyJson array
 */
export interface ExcursionRegimeLite
    extends Omit<ExcursionRegime, 'historyJson'> { }

/**
 * Central cache manager – completed simulations only
 */
export class ExcursionHistoryCache {
    // ──────────────────────────────────────────────────────────────────────────────
    // Private properties (storage & config)
    // ──────────────────────────────────────────────────────────────────────────────

    private cache: Map<string, CachedSimulationEntry[]>;           // symbol → completed entries (newest first)
    private aggregates: Map<string, ExcursionRegime>;              // symbol → precomputed regime

    private recentWindowMs: number;                                // 6 hours default
    private maxClosedSims: number;                                 // 5 default
    private cleanupIntervalMs: number = 30 * 60_000;               // 30 min periodic cleanup

    private cleanupTimer: NodeJS.Timeout | null = null;

    // ──────────────────────────────────────────────────────────────────────────────
    // Constructor – initialize storage & start periodic cleanup
    // ──────────────────────────────────────────────────────────────────────────────

    constructor() {
        this.cache = new Map();
        this.aggregates = new Map();

        // Apply config with safe defaults
        const windowHours = Math.max(1, config.strategy?.recentWindowHours ?? RECENT_WINDOW_HOURS_DEFAULT);
        this.recentWindowMs = windowHours * 60 * 60 * 1000;

        this.maxClosedSims = MAX_CLOSED_SIMS_PER_SYMBOL;

        logger.info('ExcursionHistoryCache initialized (completed-only mode)', {
            recentWindowHours: windowHours,
            recentWindowMs: this.recentWindowMs,
            maxClosedSimsPerSymbol: this.maxClosedSims,
            cleanupIntervalMin: this.cleanupIntervalMs / 60_000,
        });

        // Start periodic cleanup
        this.cleanupTimer = setInterval(() => {
            try {
                this.cleanup();
            } catch (err) {
                logger.error('Periodic cleanup failed', { error: err });
            }
        }, this.cleanupIntervalMs);
    }

    // ──────────────────────────────────────────────────────────────────────────────
    // Method stubs – signatures only (implementation to be added later)
    // ──────────────────────────────────────────────────────────────────────────────

    /**
 * Primary write method – responsible for adding a NEW completed simulation
 * or updating an EXISTING completed simulation entry for a given symbol.
 *
 * Important design decisions (2025 version):
 *   1. We **only accept completed simulations** — live/in-progress simulations
 *      are completely rejected (no more interim MFE/MAE updates)
 *   2. Entries are kept **newest first** (descending timestamp)
 *   3. We enforce two constraints immediately after write:
 *      - Time window (older than ~6 hours → discarded)
 *      - Maximum count (more than 5 → oldest discarded)
 *   4. After any change we immediately recompute aggregates for this symbol
 *      (since max 5 entries → very cheap operation)
 *   5. All operations are synchronous (no promises here) because we want
 *      predictable write behavior and immediate consistency for getRegime()
 *
 * @param symbol    - Trading pair e.g. 'BTC/USDT' (case-insensitive, will be normalized)
 * @param signalId  - Unique identifier of this simulation (usually from DB)
 * @param updates   - Data coming from finalizeSimulation (must contain at least timestamp, direction, outcome, mfe, mae)
 * @param isLive    - Parameter kept for signature compatibility, but **ignored & warned** if true
 */
    public updateOrAdd(
        symbol: string,
        signalId: string,
        updates: Partial<SimulationHistoryEntry>,
    ): void {
        // ── 1. Symbol normalization ──────────────────────────────────────────────────
        // We always work with uppercase, trimmed symbols to prevent duplicates
        // caused by case sensitivity or accidental whitespace
        const normalizedSymbol = symbol.trim().toUpperCase();

        // ── 2. Required fields validation ────────────────────────────────────────────
        // We must have at minimum these fields to consider the entry valid
        if (
            !updates.timestamp ||
            typeof updates.timestamp !== 'number' ||
            !updates.direction || !['buy', 'sell'].includes(updates.direction) ||
            !updates.outcome || !['tp', 'partial_tp', 'sl', 'timeout'].includes(updates.outcome) ||
            updates.mfe === undefined ||
            updates.mae === undefined
        ) {
            logger.warn('Incomplete completed simulation data — entry rejected', {
                symbol: normalizedSymbol,
                signalId,
                missingFields: [
                    !updates.timestamp ? 'timestamp' : null,
                    !updates.direction ? 'direction' : null,
                    !updates.outcome ? 'outcome' : null,
                    updates.mfe === undefined ? 'mfe' : null,
                    updates.mae === undefined ? 'mae' : null,
                ].filter(Boolean),
            });
            return;
        }

        // ── 3. Get or create entries array for this symbol ───────────────────────────
        let entries = this.cache.get(normalizedSymbol);

        if (!entries) {
            entries = [];
            this.cache.set(normalizedSymbol, entries);
            logger.debug('Created new entries array for symbol', { symbol: normalizedSymbol });
        }

        // ── 4. Check if this signalId already exists (update vs add) ─────────────────
        const existingIndex = entries.findIndex(e => e.signalId === signalId);

        const now = Date.now();

        // Prepare the complete entry object with safe defaults where needed
        const entryToSave: CachedSimulationEntry = {
            signalId,
            timestamp: updates.timestamp,
            lastUpdated: now, // even for completed, we record when it was last written/updated
            direction: updates.direction as 'buy' | 'sell',
            outcome: updates.outcome,
            rMultiple: updates.rMultiple ?? 0,
            label: updates.label ?? 0,
            durationMs: updates.durationMs ?? 0,
            mfe: updates.mfe,
            mae: updates.mae,
            // Spread any other fields that might be present (entryPrice, pnl, etc.)
            ...updates,
        } as CachedSimulationEntry;

        if (existingIndex !== -1) {
            // ── CASE: UPDATE EXISTING ENTRY ──────────────────────────────────────────
            // This might happen if:
            // - We correct outcome after manual review
            // - We had duplicate signalId somehow
            // - Simulation outcome was delayed/finalized later
            entries[existingIndex] = {
                ...entries[existingIndex], // keep any old fields we didn't overwrite
                ...entryToSave,
            };

            logger.debug('Updated existing completed simulation entry', {
                symbol: normalizedSymbol,
                signalId,
                newOutcome: entryToSave.outcome,
                newMfe: entryToSave.mfe,
                newMae: entryToSave.mae,
            });
        } else {
            // ── CASE: ADD NEW COMPLETED SIMULATION ───────────────────────────────────
            entries.push(entryToSave);

            logger.debug('Added new completed simulation entry', {
                symbol: normalizedSymbol,
                signalId,
                outcome: entryToSave.outcome,
                mfe: entryToSave.mfe,
                mae: entryToSave.mae,
                timestamp: new Date(entryToSave.timestamp).toISOString(),
            });
        }

        // ── 5. Always keep entries sorted newest → oldest ────────────────────────────
        // Very important: we rely on this order for slStreak and "most recent" logic
        entries.sort((a, b) => b.timestamp - a.timestamp);

        // ── 6. Immediately enforce time window + max count constraints ──────────────
        // We do this right after every write so aggregates are always based on valid set
        this._pruneEntries(entries, now);

        // If after pruning we have zero entries → clean up completely
        if (entries.length === 0) {
            this.cache.delete(normalizedSymbol);
            this.aggregates.delete(normalizedSymbol);
            logger.debug('Symbol cache completely cleaned after pruning', { symbol: normalizedSymbol });
            return;
        }

        // ── 7. Update the cache reference (in case array was modified) ───────────────
        this.cache.set(normalizedSymbol, entries);

        // ── 8. Immediately recompute aggregates for this symbol only ─────────────────
        // Because we changed data → all derived stats (ratio, streaks, counts) are stale
        this.recomputeAggregates(normalizedSymbol);
    }

    /**
 * Private method: Recomputes all aggregate statistics and outcome-derived fields
 * for a single symbol based on its current (pruned) list of completed simulations.
 *
 * Called from:
 *   1. updateOrAdd() — immediately after any write/prune
 *   2. cleanup() — after pruning a symbol during periodic maintenance
 *   3. Potentially from getRegime() if aggregates are missing (cache miss)
 *
 * Responsibilities in strict order:
 *   A. Early exit if no entries exist (clean up stale aggregate cache)
 *   B. Get the current pruned entries (already newest → oldest)
 *   C. Compute core aggregates (MFE/MAE averages, ratio, win rate, etc.)
 *   D. Compute outcome counts (tp / sl / timeout / partial_tp) — overall + directional
 *   E. Compute streaks (slStreak from newest entries)
 *   F. Compute directional breakdowns (long/short where possible)
 *   G. Build a fresh ExcursionRegime object
 *   H. Store it in this.aggregates Map (overwriting old one)
 *   I. Log key results for observability (debug/info depending on change size)
 *
 * Important invariants this method must guarantee:
 *   - All stats are computed **only from completed simulations** (no live blending)
 *   - All values are safe (no NaN, no division by zero → defaults to 0 or undefined)
 *   - Directional fields are optional (undefined if no data in that direction)
 *   - activeCount is **always 0** — we no longer track live simulations
 *   - historyJson in full regime contains **only the capped/recent entries**
 *   - Computation is deterministic and cheap (max 5 entries → trivial math)
 *
 * Performance note:
 *   - O(n) where n ≤ 5 → negligible even if called frequently
 *   - No external calls, no I/O — pure in-memory math
 *
 * @param symbol - Normalized uppercase symbol (e.g. 'BTC/USDT')
 */
    private recomputeAggregates(symbol: string): void {
        // ── STEP 1: Early exit if symbol has no entries at all ───────────────────────
        // If cache is empty for this symbol → no point computing anything
        // Also clean up any stale aggregate that might be hanging around
        const entries = this.cache.get(symbol);

        if (!entries || entries.length === 0) {
            const hadAggregate = this.aggregates.delete(symbol);

            if (hadAggregate) {
                logger.debug('Removed stale aggregate cache for symbol with no entries', {
                    symbol,
                });
            }

            logger.debug('recomputeAggregates skipped — no entries exist', { symbol });
            return;
        }

        // ── STEP 2: Log entry point for observability ────────────────────────────────
        // Helps track how often we recompute (should be only after real changes)
        logger.debug('Starting aggregate recomputation', {
            symbol,
            entryCount: entries.length,
            newestTimestamp: entries[0]?.timestamp ? new Date(entries[0].timestamp).toISOString() : 'none',
            oldestTimestamp: entries[entries.length - 1]?.timestamp
                ? new Date(entries[entries.length - 1].timestamp).toISOString()
                : 'none',
        });

        // ── STEP 3: Safe average helper (used many times below) ──────────────────────
        // Prevents NaN when dividing by zero or empty array
        // Always returns 0 on empty → conservative default
        const safeAvg = (values: number[]): number => {
            if (values.length === 0) return 0;
            const sum = values.reduce((acc, val) => acc + val, 0);
            return sum / values.length;
        };

        // ── STEP 4: Core aggregates (overall) ────────────────────────────────────────
        // These are computed from ALL recent entries (up to 5)
        const mfeValues = entries.map(e => e.mfe ?? 0);
        const maeValues = entries.map(e => e.mae ?? 0);
        const rValues = entries.map(e => e.rMultiple ?? 0);

        const recentMfe = safeAvg(mfeValues);
        const recentMae = safeAvg(maeValues);
        const recentAvgR = safeAvg(rValues);

        const recentSampleCount = entries.length;

        // Excursion ratio = MFE / |MAE| with safe handling
        const recentExcursionRatio = ExcursionHistoryCache.computeExcursionRatio(recentMfe, recentMae);

        // Win rate: percentage of entries with label >= 1 (good win or monster win)
        const winCount = entries.filter(e => (e.label ?? 0) >= 1).length;
        const recentWinRate = recentSampleCount > 0 ? winCount / recentSampleCount : 0;

        // Reverse count: strong negative outcomes (big/small loss)
        const reverseCount = entries.filter(
            e => (e.rMultiple ?? 0) < 0 && Math.abs(e.label ?? 0) >= 1
        ).length;

        // ── STEP 5: Outcome counts (overall) ─────────────────────────────────────────
        // Count how many of each exit type we have
        const outcomeCounts = {
            tp: 0,
            partial_tp: 0,
            sl: 0,
            timeout: 0,
        };

        entries.forEach(entry => {
            const outcome = entry.outcome;
            if (outcome && outcome in outcomeCounts) {
                outcomeCounts[outcome as keyof typeof outcomeCounts]++;
            }
        });

        // Timeout ratio — useful for detecting choppy / ranging markets
        const timeoutRatio = recentSampleCount > 0
            ? outcomeCounts.timeout / recentSampleCount
            : 0;

        // ── STEP 6: SL streak (consecutive stop-losses from newest entry) ────────────
        // Very important for reversal logic — consecutive SL often means strong trend against us
        let slStreak = 0;
        for (const entry of entries) {           // entries[0] is newest
            if (entry.outcome === 'sl') {
                slStreak++;
            } else {
                break;                           // streak ends at first non-SL
            }
        }

        // ── STEP 7: Directional breakdowns (long / short) ────────────────────────────
        // Only compute if we have at least one entry in that direction
        const longs = entries.filter(e => e.direction === 'buy');
        const shorts = entries.filter(e => e.direction === 'sell');

        // Longs
        const recentMfeLong = longs.length ? safeAvg(longs.map(e => e.mfe)) : undefined;
        const recentMaeLong = longs.length ? safeAvg(longs.map(e => e.mae)) : undefined;
        const recentSampleCountLong = longs.length || undefined;

        // Shorts
        const recentMfeShort = shorts.length ? safeAvg(shorts.map(e => e.mfe)) : undefined;
        const recentMaeShort = shorts.length ? safeAvg(shorts.map(e => e.mae)) : undefined;
        const recentSampleCountShort = shorts.length || undefined;

        // Optional: directional outcome counts (can be useful for very directional regimes)
        const outcomeCountsLong = longs.length ? this._computeOutcomeCounts(longs) : undefined;
        const outcomeCountsShort = shorts.length ? this._computeOutcomeCounts(shorts) : undefined;

        // ── STEP 8: Build the fresh regime object ────────────────────────────────────
        const freshRegime: ExcursionRegime = {
            symbol,

            // Include the actual capped history (newest first)
            historyJson: entries.map(e => ({ ...e }) as SimulationHistoryEntry),

            // Core stats
            recentAvgR,
            recentWinRate,
            recentReverseCount: reverseCount,
            recentMae,
            recentMfe,
            recentExcursionRatio,
            recentSampleCount,

            // Directional
            recentMfeLong,
            recentMaeLong,
            recentSampleCountLong,

            recentMfeShort,
            recentMaeShort,
            recentSampleCountShort,

            // Outcome stats (new in 2025)
            outcomeCounts,
            outcomeCountsLong,
            outcomeCountsShort,

            // Streaks & ratios
            slStreak,
            timeoutRatio,

            // No live simulations anymore
            activeCount: 0,

            // When this aggregate was last computed
            updatedAt: new Date(),
        };

        // ── STEP 9: Store the new aggregate in cache ─────────────────────────────────
        this.aggregates.set(symbol, freshRegime);

        // ── STEP 10: Observability logging ───────────────────────────────────────────
        // Show key metrics so we can see at a glance if something looks wrong
        logger.debug('Aggregates recomputed successfully', {
            symbol,
            samples: recentSampleCount,
            ratio: recentExcursionRatio.toFixed(2),
            winRatePct: (recentWinRate * 100).toFixed(1) + '%',
            slStreak,
            timeoutRatio: timeoutRatio.toFixed(2),
            outcomeSummary: `${outcomeCounts.tp} TP / ${outcomeCounts.sl} SL / ${outcomeCounts.timeout} TO`,
            directional: {
                longSamples: recentSampleCountLong ?? 0,
                shortSamples: recentSampleCountShort ?? 0,
            },
        });

        // ── End ──────────────────────────────────────────────────────────────────────
        // The aggregates Map now contains fresh, correct data for this symbol
    }

    /**
 * Tiny internal helper to count outcomes for a subset of entries (e.g. only longs)
 */
    private _computeOutcomeCounts(entries: CachedSimulationEntry[]): {
        tp: number;
        partial_tp: number;
        sl: number;
        timeout: number;
    } {
        const counts = { tp: 0, partial_tp: 0, sl: 0, timeout: 0 };

        entries.forEach(e => {
            const outcome = e.outcome;
            if (outcome && outcome in counts) {
                counts[outcome as keyof typeof counts]++;
            }
        });

        return counts;
    }

    /**
 * Private helper: Prune (remove) old entries and enforce the maximum number of
 * completed simulations allowed per symbol.
 *
 * Called from two places:
 *   1. Immediately after adding/updating an entry in updateOrAdd()
 *   2. During periodic cleanup() on every symbol
 *
 * Responsibilities in order:
 *   A. Remove entries older than the recency window (~6 hours)
 *   B. If still more entries than allowed (maxClosedSims = 5), truncate to newest 5
 *   C. Mutate the passed array in place (no return value)
 *
 * Important invariants this method must preserve:
 *   - Array remains sorted: newest entry first (index 0), oldest last
 *   - No live entries exist (we already reject them in updateOrAdd)
 *   - After pruning, length ≤ maxClosedSims AND all remaining entries are within window
 *   - Safe to call multiple times (idempotent)
 *
 * Why mutate in place?
 *   - Avoids unnecessary array allocations
 *   - Keeps code simpler in calling methods (updateOrAdd just calls this then uses the array)
 *
 * Performance:
 *   - O(n) worst case (single reverse pass to remove old entries)
 *   - Usually very fast — n ≤ 5–10 in practice
 *
 * @param entries - Mutable array of completed simulation entries for ONE symbol
 *                  **MUST already be sorted newest → oldest** before calling
 * @param now     - Current timestamp (Date.now()) — passed in so we can test with fixed time
 */
    private _pruneEntries(entries: CachedSimulationEntry[], now: number): void {
        // ── STEP 1: Calculate the cutoff timestamp ───────────────────────────────────
        // Anything older than this is considered "stale" and should be removed
        // Example: if window = 6 hours, cutoff = now - 6*60*60*1000
        const cutoffTimestamp = now - this.recentWindowMs;

        logger.debug('Starting _pruneEntries', {
            symbol: 'N/A (private method)',
            beforeCount: entries.length,
            cutoffTime: new Date(cutoffTimestamp).toISOString(),
            windowHours: this.recentWindowMs / (60 * 60 * 1000),
        });

        // ── STEP 2: Remove old entries (reverse iteration for safe splicing) ─────────
        // We iterate BACKWARDS so that removing elements doesn't mess up indices
        // This is the classic safe way to remove items while iterating an array
        let removedCount = 0;

        for (let i = entries.length - 1; i >= 0; i--) {
            const entry = entries[i];

            // If this entry's completion timestamp is BEFORE the cutoff → it's too old
            if (entry.timestamp < cutoffTimestamp) {
                // Remove it from the array
                entries.splice(i, 1);
                removedCount++;

                // Optional: log individual removal (only in debug to avoid spam)
                if (logger.isDebugEnabled()) {
                    logger.debug('Pruned old simulation entry', {
                        signalId: entry.signalId,
                        ageHours: ((now - entry.timestamp) / (60 * 60 * 1000)).toFixed(1),
                        outcome: entry.outcome,
                        reason: 'outside recency window',
                    });
                }
            }
        }

        // ── STEP 3: Enforce maximum allowed simulations (truncate if needed) ─────────
        // After removing old ones, we might still have too many recent ones
        // (e.g. 7 simulations all happened in the last 30 minutes)
        // We keep only the newest 5 (since array is already sorted newest first)
        if (entries.length > this.maxClosedSims) {
            const excess = entries.length - this.maxClosedSims;

            logger.info('Enforcing maxClosedSims limit — truncating oldest entries', {
                before: entries.length,
                maxAllowed: this.maxClosedSims,
                removing: excess,
            });

            // Simply slice off the end (oldest entries)
            // Because array is sorted newest → oldest, entries[maxClosedSims] and beyond are oldest
            entries.length = this.maxClosedSims;

            // Optional: log which ones were dropped (debug only)
            if (logger.isDebugEnabled()) {
                logger.debug('Truncated oldest simulations', {
                    keptNewest: this.maxClosedSims,
                    droppedOldest: excess,
                    oldestKeptTimestamp: entries[entries.length - 1]?.timestamp,
                });
            }
        }

        // ── STEP 4: Final logging / validation ───────────────────────────────────────
        const afterCount = entries.length;

        if (removedCount > 0 || afterCount < entries.length) {
            logger.info('Prune operation completed', {
                removedByTime: removedCount,
                truncatedByLimit: Math.max(0, (entries.length + removedCount) - this.maxClosedSims),
                finalCount: afterCount,
                stillWithinWindow: afterCount === 0 || entries.every(e => e.timestamp >= cutoffTimestamp),
                newestTimestamp: entries[0]?.timestamp ? new Date(entries[0].timestamp).toISOString() : 'none',
            });
        } else {
            logger.debug('No pruning needed — entries already valid', {
                count: afterCount,
                withinWindow: true,
            });
        }

        // ── End of method ────────────────────────────────────────────────────────────
        // The array has now been mutated:
        //   - All remaining entries are recent (timestamp >= cutoff)
        //   - Length <= maxClosedSims
        //   - Still sorted newest first (splice doesn't break order)
    }

    /**
 * Public read method: Retrieves the **full** excursion regime for a given symbol.
 *
 * This is the richer version of the regime data — it includes:
 *   • All computed aggregates (MFE/MAE averages, ratio, win rate, reverse count...)
 *   • Outcome counts (tp/sl/timeout/partial_tp) — overall + directional
 *   • SL streak and timeout ratio
 *   • The actual array of recent completed simulations (`historyJson`) — newest first, max 5
 *
 * When to use this method (vs getRegimeLite):
 *   - When you need to see the raw recent simulation history (e.g. debugging, last-two checks)
 *   - When displaying detailed excursion info in logs/alerts/UI
 *   - When ML feature extraction needs the individual entries
 *
 * Performance characteristics:
 *   - O(1) in the common case (aggregates already cached after a write)
 *   - O(n) only on cache miss (n ≤ 5 → recompute is extremely fast)
 *   - Thread-safe for concurrent reads (Map.get is atomic in JS)
 *
 * Behavior on edge cases:
 *   - No data at all for symbol → returns `null`
 *   - Cache miss but entries exist → computes fresh aggregates automatically
 *   - Symbol had data but all pruned (too old) → returns `null` and cleans up
 *
 * @param symbol - Trading pair (e.g. 'BTC/USDT') — case-insensitive, will be normalized
 * @returns Full `ExcursionRegime` object or `null` if no recent completed simulations exist
 */
    public getRegime(symbol: string): ExcursionRegime | null {
        // ── STEP 1: Normalize the symbol (same as in updateOrAdd) ─────────────────────
        // Prevents bugs from inconsistent casing or whitespace
        const normalized = symbol.trim().toUpperCase();

        // ── STEP 2: Fast path — check if we already have fresh aggregates cached ──────
        // Because we recompute aggregates immediately after every write/prune,
        // this should be hit 99%+ of the time in production.
        let regime = this.aggregates.get(normalized);

        if (regime) {
            // Quick sanity check (should never fail in correct code)
            if (regime.symbol !== normalized) {
                logger.warn('Cached regime symbol mismatch — this should never happen', {
                    requested: normalized,
                    cached: regime.symbol,
                });
                // Still return it — better than crashing
            }

            logger.debug('Returning cached full regime (fast path)', {
                symbol: normalized,
                sampleCount: regime.recentSampleCount,
                slStreak: regime.slStreak,
                ratio: regime.recentExcursionRatio.toFixed(2),
                cachedAt: regime.updatedAt.toISOString(),
            });

            return regime;
        }

        // ── STEP 3: Cache miss — check if we even have raw entries to work with ───────
        const entries = this.cache.get(normalized);

        if (!entries || entries.length === 0) {
            // No raw data → definitely no regime
            // Clean up any stale aggregate reference just in case
            this.aggregates.delete(normalized);

            logger.debug('getRegime returning null — no simulation data exists', {
                symbol: normalized,
            });

            return null;
        }

        // ── STEP 4: Entries exist but aggregates missing → force recomputation ────────
        // This is the slow path — but because max 5 entries, it's still very fast
        logger.debug('Cache miss on full regime — triggering recomputeAggregates', {
            symbol: normalized,
            entryCount: entries.length,
            newest: entries[0]?.timestamp ? new Date(entries[0].timestamp).toISOString() : 'none',
        });

        // This call will:
        //   - Recompute everything from the current entries
        //   - Store fresh result in this.aggregates
        //   - Log key metrics
        this.recomputeAggregates(normalized);

        // ── STEP 5: Retrieve the freshly computed regime ─────────────────────────────
        regime = this.aggregates.get(normalized);

        if (!regime) {
            // This should almost never happen unless recomputeAggregates failed silently
            logger.error('recomputeAggregates ran but no regime was stored — possible bug', {
                symbol: normalized,
                entryCount: entries.length,
            });
            return null;
        }

        // ── STEP 6: Final success logging (info level since it's a cache miss) ───────
        logger.info('Full regime computed on cache miss and returned', {
            symbol: normalized,
            samples: regime.recentSampleCount,
            ratio: regime.recentExcursionRatio.toFixed(2),
            winRatePct: (regime.recentWinRate * 100).toFixed(1) + '%',
            slStreak: regime.slStreak,
            timeoutRatio: regime.timeoutRatio.toFixed(2),
            outcomeSummary: `${regime.outcomeCounts.tp} TP / ${regime.outcomeCounts.sl} SL / ${regime.outcomeCounts.timeout} TO`,
            computedAt: regime.updatedAt.toISOString(),
        });

        // ── STEP 7: Return the result ────────────────────────────────────────────────
        return regime;
    }

    /**
 * Public read method: Retrieves the **lightweight** excursion regime for a given symbol.
 *
 * This is the **optimized, memory-efficient** version of the regime data — it contains:
 *   • All computed aggregates (MFE/MAE averages, ratio, win rate, reverse count...)
 *   • Outcome counts (tp/sl/timeout/partial_tp) — overall + directional
 *   • SL streak and timeout ratio
 *   • **NO** `historyJson` array (saves memory & allocation cost)
 *
 * When to use this method (vs getRegime):
 *   - In performance-critical loops (strategy scoring, risk filters, alert generation)
 *   - When sending regime data over network / logging frequently
 *   - When you only need the summary numbers and not the raw simulation entries
 *
 * Performance characteristics:
 *   - O(1) in the common case (aggregates already cached)
 *   - O(n) only on rare cache miss (n ≤ 5 → recompute is trivial)
 *   - Slightly faster & lower memory than getRegime because no array is copied/returned
 *   - Thread-safe for concurrent reads
 *
 * Behavior on edge cases:
 *   - No data → returns `null`
 *   - Cache miss but entries exist → computes fresh aggregates automatically
 *   - All entries pruned (too old) → returns `null` and cleans up
 *
 * @param symbol - Trading pair (e.g. 'BTC/USDT') — case-insensitive, normalized internally
 * @returns Lightweight `ExcursionRegimeLite` object or `null` if no recent completed simulations exist
 */
    public getRegimeLite(symbol: string): ExcursionRegimeLite | null {
        // ── STEP 1: Normalize symbol once (consistency with updateOrAdd & getRegime) ──
        const normalized = symbol.trim().toUpperCase();

        // ── STEP 2: Fast path — check for existing cached aggregates ─────────────────
        // Because we eagerly recompute on every write/prune, this should be hit almost always
        let regime = this.aggregates.get(normalized);

        if (regime) {
            // Optional sanity check (should never fail in correct code)
            if (regime.symbol !== normalized) {
                logger.warn('Cached lite regime symbol mismatch — possible corruption', {
                    requested: normalized,
                    cached: regime.symbol,
                });
                // Proceed anyway — data is still usable
            }

            // Create lightweight version by destructuring out historyJson
            // This avoids copying the array reference unnecessarily
            const { historyJson, ...liteRegime } = regime;

            logger.debug('Returning cached lightweight regime (fast path)', {
                symbol: normalized,
                sampleCount: liteRegime.recentSampleCount,
                slStreak: liteRegime.slStreak,
                ratio: liteRegime.recentExcursionRatio.toFixed(2),
                timeoutRatio: liteRegime.timeoutRatio.toFixed(2),
                cachedAt: liteRegime.updatedAt.toISOString(),
            });

            return liteRegime as ExcursionRegimeLite;
        }

        // ── STEP 3: Cache miss — check if we have any raw data to compute from ───────
        const entries = this.cache.get(normalized);

        if (!entries || entries.length === 0) {
            // No raw entries → no regime possible
            // Clean up any stale aggregate reference (defensive)
            this.aggregates.delete(normalized);

            logger.debug('getRegimeLite returning null — no simulation data', {
                symbol: normalized,
            });

            return null;
        }

        // ── STEP 4: Cache miss but entries exist → force recomputation ───────────────
        // This is the only time we do real work — but max 5 entries → very cheap
        logger.debug('Cache miss on lightweight regime — triggering recomputeAggregates', {
            symbol: normalized,
            entryCount: entries.length,
            newest: entries[0]?.timestamp ? new Date(entries[0].timestamp).toISOString() : 'none',
        });

        // Recompute will populate this.aggregates with fresh data
        this.recomputeAggregates(normalized);

        // ── STEP 5: Retrieve the freshly computed regime ─────────────────────────────
        regime = this.aggregates.get(normalized);

        if (!regime) {
            // Should almost never happen — recomputeAggregates failed to store result
            logger.error('recomputeAggregates ran but no regime stored — possible bug', {
                symbol: normalized,
                entryCount: entries.length,
            });
            return null;
        }

        // ── STEP 6: Strip historyJson to create lightweight version ──────────────────
        const { historyJson, ...liteRegime } = regime;

        // ── STEP 7: Success logging (info level because cache miss is noteworthy) ────
        logger.info('Lightweight regime computed on cache miss and returned', {
            symbol: normalized,
            samples: liteRegime.recentSampleCount,
            ratio: liteRegime.recentExcursionRatio.toFixed(2),
            winRatePct: (liteRegime.recentWinRate * 100).toFixed(1) + '%',
            slStreak: liteRegime.slStreak,
            timeoutRatio: liteRegime.timeoutRatio.toFixed(2),
            outcomeSummary: `${liteRegime.outcomeCounts.tp} TP / ${liteRegime.outcomeCounts.sl} SL / ${liteRegime.outcomeCounts.timeout} TO`,
            computedAt: liteRegime.updatedAt.toISOString(),
        });

        // ── STEP 8: Return the stripped lightweight object ───────────────────────────
        return liteRegime as ExcursionRegimeLite;
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
     * Formula (conceptually):
     *   excursionRatio = MFE / |MAE|
     *
     * This single number tells us, historically:
     *   - How much favorable price movement (profit potential) we get
     *     compared to the adverse movement (drawdown pain) we have to endure
     *
     * Interpretation guide:
     *   > 2.0     → Excellent — strong reward relative to risk (favor this direction)
     *   1.5–2.0   → Good — meaningful edge
     *   ~1.0      → Balanced — reward roughly equals risk
     *   0.5–1.0   → Poor — more pain than gain (caution / possible skip or reverse)
     *   < 0.5     → Very dangerous — drawdowns dominate (strong reverse candidate)
     *   0         → No meaningful data (MAE=0 or MFE=0)
     *
     * Safety & edge-case handling (critical for production stability):
     *   - Never divide by zero → returns 0 when MAE is zero (conservative)
     *   - Handles negative/zero MFE → returns 0 (no favorable movement = no ratio)
     *   - Uses absolute value of MAE (since MAE is conventionally negative or zero)
     *   - Caps extreme ratios to prevent numeric weirdness downstream (e.g. Infinity)
     *   - No side effects, pure function — safe to call anywhere
     *
     * Why this method exists as static:
     *   - Reusable in many places (strategy, alerts, ML features, excursionUtils)
     *   - No dependency on instance state → can be called without cache object
     *   - Central single source of truth for how ratio is calculated
     *
     * @param mfe - Maximum Favorable Excursion (positive or zero)
     *              Best unrealized profit seen (% or points relative to entry)
     * @param mae - Maximum Adverse Excursion (negative or zero)
     *              Worst unrealized drawdown seen (% or points relative to entry)
     * @returns The safe MFE / |MAE| ratio (≥ 0)
     *          - 0 when no meaningful ratio can be computed
     *          - Positive number indicating historical reward-to-risk efficiency
     *
     * @example
     * computeExcursionRatio(3.2, -1.1)   // → ~2.91  (strong)
     * computeExcursionRatio(0.8, -2.0)   // → 0.40   (poor)
     * computeExcursionRatio(4.5, 0)      // → 0      (no drawdown → undefined)
     * computeExcursionRatio(0, -1.5)     // → 0      (no favorable movement)
     * computeExcursionRatio(-1, -2)      // → 0      (invalid negative MFE)
     */
    public static computeExcursionRatio(mfe: number, mae: number): number {
        // ── STEP 1: Early rejection of meaningless inputs ────────────────────────────
        // If MFE is zero or negative → no favorable movement ever occurred
        // Ratio is undefined → return conservative 0
        if (mfe <= 0) {
            // Optional debug log when this happens frequently (helps detect data issues)
            if (logger.isDebugEnabled() && mfe < 0) {
                logger.debug('computeExcursionRatio received negative MFE — treated as 0', {
                    inputMfe: mfe,
                    inputMae: mae,
                    result: 0,
                });
            }
            return 0;
        }

        // ── STEP 2: Handle zero MAE case (no drawdown observed) ──────────────────────
        // Mathematically undefined (division by zero)
        // We choose conservative return value: 0
        // Treating it as infinite reward would be dangerous (over-optimistic)
        if (mae === 0) {
            return 0;
        }

        // ── STEP 3: Core calculation ─────────────────────────────────────────────────
        // MAE is negative by convention → take absolute value for magnitude
        const absMae = Math.abs(mae);

        // Very small MAE protection — floating-point noise can cause huge ratios
        // Threshold is intentionally tiny (0.0001% is negligible in crypto)
        if (absMae < 1e-6) {
            logger.debug('computeExcursionRatio protected against tiny MAE', {
                absMae,
                mfe,
                result: 0,
            });
            return 0;
        }

        // Actual ratio: how many times bigger is best profit vs worst loss
        let ratio = mfe / absMae;

        // ── STEP 4: Final safety clamp (prevent numeric instability downstream) ──────
        // While theoretically possible to have very high ratios (e.g. 100× in pumps),
        // extreme values can cause issues in comparisons/multipliers/alert logic
        // We cap at a reasonable but generous value (50× is already exceptional)
        const MAX_REASONABLE_RATIO = 50;
        if (ratio > MAX_REASONABLE_RATIO) {
            logger.debug('Excursion ratio capped for safety', {
                rawRatio: ratio,
                cappedTo: MAX_REASONABLE_RATIO,
                mfe,
                absMae,
            });
            ratio = MAX_REASONABLE_RATIO;
        }

        // ── STEP 5: Return final safe value ──────────────────────────────────────────
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
 * This is a critical **safety filter** used in:
 *   - Strategy.generateSignal() — to potentially skip or demote signals
 *   - getExcursionAdvice() — to influence action ('skip', tighten SL, etc.)
 *   - AutoTradeService — to block or reduce live position size
 *   - Alerts / UI — to show red flags / warnings
 *
 * Main decision logic (priority order):
 *   1. Require minimum trusted samples (default 2 in 2025) — if too few → conservative false (not high risk yet)
 *   2. Prefer **directional MAE** if enough directional samples exist (most relevant)
 *   3. Fallback to **overall MAE** if directional data is insufficient
 *   4. Compare absolute MAE against configurable max threshold (default 3.0%)
 *   5. Optional future enhancement: factor in slStreak or outcomeCounts.sl for stronger signal
 *
 * Returns:
 *   true  → High drawdown risk detected → typically skip / reduce size / warn
 *   false → Acceptable risk (or insufficient data to judge) → can proceed with caution
 *
 * Safety principles:
 *   - Fail-open on missing/invalid data → returns false (better to allow cautious trading than block everything)
 *   - Never throws — always returns boolean
 *   - Very defensive against undefined/missing regime fields
 *   - Logging only when actually risky (debug level) — keeps production clean
 *
 * Configurability:
 *   - maxMaePct → config.strategy.maxMaePct (default 3.0)
 *   - minSamples → config.strategy.minExcursionSamples (default 2 in 2025)
 *
 * @param regime    - Full or lite ExcursionRegime object from cache
 * @param direction - Intended trade direction ('long' = buy, 'short' = sell)
 * @returns boolean — true if drawdown risk is considered dangerously high
 *
 * @example
 * isHighMaeRisk(regime, 'long')   // true if directional long MAE > -3.0% (with enough samples)
 * isHighMaeRisk(regime, 'short')  // false if no short data or MAE within limits
 */
    public static isHighMaeRisk(
        regime: ExcursionRegime | ExcursionRegimeLite,
        direction: 'long' | 'short'
    ): boolean {
        // ── STEP 1: Configuration values (centralized, overridable) ──────────────────
        // These should ideally live in config.strategy (already partially do)
        const MAX_MAE_PCT_DEFAULT = 3.0;          // 3% average drawdown is our danger threshold
        const MIN_SAMPLES_FOR_TRUST = 2; // lowered to 2 in 2025

        const maxMaePct = config.strategy?.maxMaePct ?? MAX_MAE_PCT_DEFAULT;

        // ── STEP 2: Early exit — not enough overall samples to trust any judgment ─────
        // If we don't have enough completed simulations → conservative: NOT high risk yet
        // (prevents blocking new symbols too aggressively while data accumulates)
        if ((regime.recentSampleCount ?? 0) < MIN_SAMPLES_FOR_TRUST) {
            // Optional debug log when borderline — helps tune min samples
            if (logger.isDebugEnabled() && (regime.recentSampleCount ?? 0) > 0) {
                logger.debug('isHighMaeRisk: insufficient overall samples — treated as safe', {
                    symbol: regime.symbol,
                    samples: regime.recentSampleCount,
                    required: MIN_SAMPLES_FOR_TRUST,
                    direction,
                });
            }
            return false;
        }

        // ── STEP 3: Select the most relevant MAE value (priority order) ───────────────
        let selectedMae: number | undefined;

        // Priority 1: Directional MAE — most specific and relevant
        if (direction === 'long') {
            selectedMae = regime.recentMaeLong;
        } else if (direction === 'short') {
            selectedMae = regime.recentMaeShort;
        }

        // Priority 2: Fallback to overall MAE if directional not available or insufficient
        if (selectedMae === undefined) {
            selectedMae = regime.recentMae;

            // Log fallback (debug) — helps understand data coverage
            if (logger.isDebugEnabled()) {
                logger.debug('isHighMaeRisk: falling back to overall MAE (no directional data)', {
                    symbol: regime.symbol,
                    direction,
                    overallMae: selectedMae?.toFixed(3),
                    directionalMae: direction === 'long' ? regime.recentMaeLong : regime.recentMaeShort,
                });
            }
        }

        // ── STEP 4: Final safety check — no usable MAE value → treat as safe ──────────
        // Could happen if:
        //   - No data in that direction
        //   - All MAE values are undefined/zero
        if (selectedMae === undefined || selectedMae === 0) {
            logger.debug('isHighMaeRisk: no meaningful MAE value — treated as safe', {
                symbol: regime.symbol,
                direction,
                selectedMae,
            });
            return false;
        }

        // ── STEP 5: Core risk decision — compare absolute drawdown to threshold ───────
        const absMae = Math.abs(selectedMae);
        const isHighRisk = absMae > maxMaePct;

        // ── STEP 6: Detailed debug logging only when risk is actually high ───────────
        // Helps diagnose why trades are being blocked/reduced
        if (isHighRisk && logger.isDebugEnabled()) {
            const source = selectedMae === regime.recentMae ? 'overall' : direction;

            logger.debug('High MAE risk DETECTED', {
                symbol: regime.symbol,
                direction,
                maeValue: selectedMae.toFixed(3),
                absMae: absMae.toFixed(3),
                threshold: maxMaePct,
                source,
                sampleCount: regime.recentSampleCount,
                directionalSamples: direction === 'long'
                    ? regime.recentSampleCountLong
                    : regime.recentSampleCountShort,
                slStreak: regime.slStreak,              // extra context
                slCount: regime.outcomeCounts?.sl ?? 0, // extra context
            });
        }

        // ── STEP 7: Return final boolean decision ────────────────────────────────────
        return isHighRisk;
    }

    /**
 * Static utility method: Determines whether we have **enough completed simulation samples**
 * in the recent regime to reasonably trust the computed statistics (MFE/MAE averages,
 * win rate, excursion ratio, outcome counts, slStreak, etc.).
 *
 * This is a **critical confidence gate** used in many places:
 *   - getExcursionAdvice() — to decide whether to trust regime data or skip/reverse cautiously
 *   - Strategy.generateSignal() — to reduce confidence, skip, or add warnings when data is sparse
 *   - AutoTradeService — to block or heavily reduce size on low-sample symbols
 *   - Alerts / UI — to show "limited data" disclaimers
 *
 * Main rules (2025 version):
 *   - Uses `recentSampleCount` (completed simulations within time window) as primary metric
 *   - Default minimum raised/lowered to 2 per your request (configurable via config)
 *   - Very conservative by nature: better to say "not enough data" than trust noisy stats
 *   - Only counts **completed** simulations — live/in-progress don't count toward trust
 *   - Returns false on missing/invalid regime → fail-safe (treat as not trusted)
 *
 * Why completed-only?
 *   - Win rate, average R, reverse count, outcome counts, streaks — all require closed outcomes
 *   - Live simulations are useful for current MFE/MAE extremes, but unreliable for statistics
 *
 * Configurability:
 *   - minSamples default = config.strategy.minExcursionSamples ?? 2
 *   - Caller can override (e.g. stricter checks in risk filters)
 *
 * Returns:
 *   true  → Enough samples → trust aggregates / outcome stats / streaks
 *   false → Too few samples → be cautious (lower confidence, add warnings, skip, etc.)
 *
 * @param regime     - Full or lite ExcursionRegime object from cache
 * @param minSamples - Optional override for minimum trusted samples
 *                     Default pulled from config (2 in 2025)
 * @returns boolean — true if we have enough completed samples to trust regime statistics
 *
 * @example
 * hasEnoughSamples(regime)                  // true if recentSampleCount >= 2
 * hasEnoughSamples(regime, 5)               // stricter check — needs >=5
 * hasEnoughSamples({ recentSampleCount: 1 }) // false
 * hasEnoughSamples(undefined as any)        // false (defensive)
 */
    public static hasEnoughSamples(
        regime: ExcursionRegime | ExcursionRegimeLite | null | undefined,
        minSamples: number = MIN_SAMPLES_FOR_TRUST_DEFAULT
    ): boolean {
        // ── STEP 1: Input safety — handle null/undefined regime gracefully ───────────
        // This method is called in many places — better to fail-safe than crash
        if (!regime || typeof regime !== 'object') {
            logger.debug('hasEnoughSamples called with invalid regime — treated as insufficient', {
                regimeType: regime === null ? 'null' : typeof regime,
                minSamples,
            });
            return false;
        }

        // ── STEP 2: Normalize minSamples (protect against bad caller input) ──────────
        // Make sure it's a reasonable positive integer
        const effectiveMin = Math.max(1, Math.floor(minSamples));

        // ── STEP 3: Core decision — check completed sample count ─────────────────────
        // recentSampleCount is the single source of truth (set in recomputeAggregates)
        const completedCount = regime.recentSampleCount ?? 0;

        const hasEnough = completedCount >= effectiveMin;

        // ── STEP 4: Borderline debug logging (helps tuning minSamples value) ─────────
        // Only logs when close to threshold — avoids spam in production
        if (logger.isDebugEnabled() && completedCount > 0 && completedCount < effectiveMin + 3) {
            logger.debug('Borderline sample count for regime trust', {
                symbol: regime.symbol ?? 'unknown',
                completedSamples: completedCount,
                requiredMinimum: effectiveMin,
                decision: hasEnough ? 'trusted' : 'not trusted',
                directionContext: 'N/A (overall)', // could extend later for directional
                timeoutRatio: regime.timeoutRatio?.toFixed(2) ?? 'n/a',
                slStreak: regime.slStreak ?? 0,
            });
        }

        // ── STEP 5: Return clean boolean result ──────────────────────────────────────
        return hasEnough;
    }
}

// Singleton export
export const excursionCache = new ExcursionHistoryCache();
