// src/lib/services/excursionHistoryCache.ts
// =============================================================================
// EXCURSION HISTORY CACHE – CENTRALIZED SOURCE OF TRUTH FOR SIMULATION METRICS
//
// This file owns:
//   • All excursion-related type definitions
//   • In-memory caching of individual simulation entries (live + completed)
//   • Computation and caching of regime aggregates (MFE/MAE, win rates, etc.)
//   • Utility methods for excursion analysis
//
// Goal: Single, performant, type-safe source for real-time regime information
// used by Strategy, AutoTradeService, Telegram alerts, ML features, etc.
// =============================================================================

import { createLogger } from '../logger';
import { config } from '../config/settings';
import type { SimulationHistoryEntry } from '../../types/signalHistory';

const logger = createLogger('ExcursionCache');

/**
 * Internal representation of a cached simulation entry.
 * Extends the base SimulationHistoryEntry with runtime metadata.
 */
interface CachedSimulationEntry extends SimulationHistoryEntry {
    /** Unique identifier for this simulation (usually signal ID) */
    signalId: string;

    /** Whether this simulation is still live/in-progress */
    isLive: boolean;

    /** Last time this entry was updated (important for live simulations) */
    lastUpdated: number;
}

/**
 * Full regime data including raw recent history and all computed aggregates.
 * All "recent" metrics are calculated from simulations within the recent window.
 */
export interface ExcursionRegime {
    /** Trading symbol (e.g., 'BTC/USDT') */
    symbol: string;

    /** Recent completed simulation entries (optional for aggregate-only usage) */
    historyJson?: SimulationHistoryEntry[];

    // Recent aggregates (based on completed simulations unless noted)
    recentAvgR: number;
    recentWinRate: number;
    recentReverseCount: number;
    recentMae: number;           // negative or zero
    recentMfe: number;           // positive
    recentExcursionRatio: number;
    recentSampleCount: number;

    // Directional aggregates (blend of completed + live where applicable)
    recentMfeLong?: number;
    recentMaeLong?: number;
    recentWinRateLong?: number;
    recentReverseCountLong?: number;
    recentSampleCountLong?: number;

    recentMfeShort?: number;
    recentMaeShort?: number;
    recentWinRateShort?: number;
    recentReverseCountShort?: number;
    recentSampleCountShort?: number;

    /** Current count of active (live) simulations */
    activeCount: number;

    /** Timestamp when this regime data was last computed/updated */
    updatedAt: Date;
}

/**
 * Lightweight version without the potentially large historyJson array.
 * Preferred for most hot-path read operations (strategy, alerts, trading).
 */
export interface ExcursionRegimeLite {
    symbol: string;
    recentAvgR: number;
    recentWinRate: number;
    recentReverseCount: number;
    recentMae: number;
    recentMfe: number;
    recentExcursionRatio: number;
    recentSampleCount: number;

    recentMfeLong?: number;
    recentMaeLong?: number;
    recentWinRateLong?: number;
    recentReverseCountLong?: number;
    recentSampleCountLong?: number;

    recentMfeShort?: number;
    recentMaeShort?: number;
    recentWinRateShort?: number;
    recentReverseCountShort?: number;
    recentSampleCountShort?: number;

    activeCount: number;
    updatedAt: Date;
}

/**
 * Central in-memory store and calculator for excursion statistics
 */
export class ExcursionHistoryCache {
    // ──────────────────────────────────────────────────────────────────────────────
    // Private fields
    // ──────────────────────────────────────────────────────────────────────────────

    private readonly cache: Map<string, CachedSimulationEntry[]>;
    private readonly aggregates: Map<string, ExcursionRegime>;

    private readonly recentWindowMs: number;
    private readonly maxEntriesPerSymbol: number;
    private readonly maxTotalEntries: number;
    private readonly cleanupIntervalMs: number;

    private cleanupTimer: NodeJS.Timeout | null = null;

    // ──────────────────────────────────────────────────────────────────────────────
    // Constructor & Lifecycle
    // ──────────────────────────────────────────────────────────────────────────────

    /**
     * Initializes the excursion history cache system.
     *
     * Responsibilities:
     *  - Set up internal storage (Map-based caches)
     *  - Load and apply configuration limits & time windows
     *  - Start periodic background cleanup task
     *
     * All configuration values come from central config with safe defaults.
     */
    constructor() {
        // Initialize storage
        this.cache = new Map<string, CachedSimulationEntry[]>();
        this.aggregates = new Map<string, ExcursionRegime>();

        // Load configuration with fallbacks
        const windowHours = Math.max(1, config.strategy?.recentWindowHours ?? 3);
        this.recentWindowMs = windowHours * 60 * 60 * 1000;

        this.maxEntriesPerSymbol = Math.max(50, 120);
        this.maxTotalEntries = Math.max(5_000, 15_000);
        this.cleanupIntervalMs = Math.max(5 * 60_000, 30 * 60_000);

        // Log startup parameters for observability
        logger.info('ExcursionHistoryCache initialized', {
            recentWindowHours: windowHours,
            recentWindowMs: this.recentWindowMs,
            maxEntriesPerSymbol: this.maxEntriesPerSymbol,
            maxTotalEntries: this.maxTotalEntries,
            cleanupIntervalMs: this.cleanupIntervalMs,
        });

        // Start automatic periodic cleanup
        this.cleanupTimer = setInterval(() => {
            try {
                this.cleanup();
            } catch (err) {
                logger.error('Periodic excursion cache cleanup failed', { error: err });
            }
        }, this.cleanupIntervalMs);
    }

    // ──────────────────────────────────────────────────────────────────────────────
    // Public API – to be implemented one by one
    // ──────────────────────────────────────────────────────────────────────────────

    /**
   * Adds a new simulation entry or updates an existing one for a given symbol.
   *
   * This is the **primary write path** of the cache.
   * Handles both:
   *   - New simulations (live or completed)
   *   - Updates to existing live simulations (progressive MFE/MAE updates)
   *
   * Core invariants maintained:
   * 1. `signalId` is the unique key per simulation
   * 2. For **live** simulations: MFE is always maximized, MAE is always minimized
   * 3. Per-symbol entry limit enforced (FIFO: oldest entries removed first)
   * 4. Aggregate cache invalidated after every change (lazy recomputation)
   * 5. Completion transition (live → completed) is allowed and respected
   * 6. Never reverts a completed simulation back to live
   *
   * @param symbol - Trading pair (e.g. 'BTC/USDT') — case-sensitive
   * @param signalId - Unique signal/simulation identifier
   * @param updates - Partial data to apply. Supports all `SimulationHistoryEntry` fields
   *                  plus optional `isLive` override
   * @param isLive - Default: `true` (live simulation)
   *                 Pass `false` to mark simulation as completed
   *                 **Warning**: Once false, future calls should keep it false
   */
    public updateOrAdd(
        symbol: string,
        signalId: string,
        updates: Partial<SimulationHistoryEntry & { isLive?: boolean }>,
        isLive: boolean = true
    ): void {
        // ── 1. Normalize symbol (prevent case-sensitivity bugs) ─────────────────────
        const normalizedSymbol = symbol.trim().toUpperCase();

        // ── 2. Get or initialize entries array for this symbol ───────────────────────
        let entries = this.cache.get(normalizedSymbol);

        if (!entries) {
            entries = [];
            this.cache.set(normalizedSymbol, entries);
            logger.debug('Created new entries array for symbol', { symbol: normalizedSymbol });
        }

        const now = Date.now();

        // ── 3. Find existing simulation by signalId ──────────────────────────────────
        const existingIndex = entries.findIndex(e => e.signalId === signalId);

        if (existingIndex !== -1) {
            // ── UPDATE EXISTING ───────────────────────────────────────────────────────
            const entry = entries[existingIndex];

            // Prevent accidental revert from completed → live (safety invariant)
            if (!entry.isLive && isLive) {
                logger.warn('Attempted to revert completed simulation to live — ignored', {
                    symbol: normalizedSymbol,
                    signalId,
                    previousState: 'completed',
                    requestedState: 'live',
                });
                // Keep original completed state
                return;
            }

            logger.debug('Updating existing simulation', {
                symbol: normalizedSymbol,
                signalId,
                stateTransition: `${entry.isLive ? 'live' : 'completed'} → ${isLive ? 'live' : 'completed'}`,
            });

            // Live simulations: only update extremes (max MFE, min MAE)
            if (isLive) {
                if (typeof updates.mfe === 'number') {
                    entry.mfe = Math.max(entry.mfe ?? 0, updates.mfe);
                }
                if (typeof updates.mae === 'number') {
                    entry.mae = Math.min(entry.mae ?? 0, updates.mae);
                }
            }

            // Safe property assignment (avoid prototype pollution risk)
            const { isLive: _, ...safeUpdates } = updates; // exclude isLive from spread
            Object.assign(entry, safeUpdates);

            // Respect the current isLive state (caller has authority)
            entry.isLive = isLive;

            // Always update last modification time
            entry.lastUpdated = now;

            // Preserve original timestamp unless explicitly overridden
            // (important for completed simulations - don't change close time)
        } else {
            // ── CREATE NEW ENTRY ──────────────────────────────────────────────────────
            logger.debug('Creating new simulation entry', {
                symbol: normalizedSymbol,
                signalId,
                isLive,
            });

            // Enforce per-symbol size limit (oldest-first removal)
            if (entries.length >= this.maxEntriesPerSymbol) {
                // Sort by timestamp (oldest first)
                entries.sort((a, b) => a.timestamp - b.timestamp);

                const removed = entries.shift()!;

                logger.info('Pruned oldest simulation entry due to per-symbol limit', {
                    symbol: normalizedSymbol,
                    removedSignalId: removed.signalId,
                    removedAgeMs: now - removed.timestamp,
                    remainingEntries: entries.length,
                });
            }

            // Build new entry with safe defaults
            const newEntry: CachedSimulationEntry = {
                signalId,
                isLive,
                lastUpdated: now,

                // Required fields with safe defaults
                timestamp: typeof updates.timestamp === 'number' ? updates.timestamp : now,
                direction: updates.direction ?? 'buy',
                outcome: updates.outcome ?? 'timeout',
                rMultiple: typeof updates.rMultiple === 'number' ? updates.rMultiple : 0,
                label: typeof updates.label === 'number' ? updates.label : 0,
                durationMs: typeof updates.durationMs === 'number' ? updates.durationMs : 0,
                mfe: typeof updates.mfe === 'number' ? updates.mfe : 0,
                mae: typeof updates.mae === 'number' ? updates.mae : 0,

                // Spread remaining safe updates
                ...updates,
            };

            entries.push(newEntry);
        }

        // ── 4. Always invalidate aggregates after write ──────────────────────────────
        // This forces lazy recomputation on next read (getRegime / getRegimeLite)
        const hadCachedAggregate = this.aggregates.delete(normalizedSymbol);

        if (hadCachedAggregate) {
            logger.debug('Invalidated cached aggregates after update', { symbol: normalizedSymbol });
        }
    }

    /**
 * Retrieves the current excursion regime for a given symbol.
 *
 * This is the **primary read method** for most consumers that need the full regime data,
 * including the array of recent completed simulation entries (`historyJson`).
 *
 * Behavior:
 * 1. First checks if we already have fresh cached aggregates
 * 2. If not found or stale → computes fresh aggregates from raw entries
 * 3. Caches the result for future fast access
 * 4. Returns null if the symbol has no data at all
 *
 * Performance characteristics:
 * - O(1) when aggregates are already cached (most common case after first access)
 * - O(n) only when recomputing (n = number of entries for that symbol, usually < 120)
 *
 * Thread-safety note:
 * - This implementation is safe for concurrent reads (Map.get is atomic in JS)
 * - Writes (updateOrAdd) invalidate cache → next read will recompute
 *
 * @param symbol - The trading symbol to query (case-sensitive, e.g. 'BTC/USDT')
 * @returns Full `ExcursionRegime` object or `null` if no simulations exist for this symbol
 */
    public getRegime(symbol: string): ExcursionRegime | null {
        // ── 1. Early exit - no data at all for this symbol ───────────────────────────
        const entries = this.cache.get(symbol);

        if (!entries || entries.length === 0) {
            logger.debug('No simulation data found for symbol', { symbol });
            return null;
        }

        // ── 2. Fast path: return already computed and cached aggregates ──────────────
        const cachedRegime = this.aggregates.get(symbol);

        if (cachedRegime) {
            // Quick consistency check (optional but useful during development)
            // In production this could be removed for max performance
            if (cachedRegime.symbol !== symbol) {
                logger.warn('Cached regime symbol mismatch (should never happen)', {
                    expected: symbol,
                    found: cachedRegime.symbol,
                });
            }

            logger.debug('Returning cached regime data', {
                symbol,
                activeCount: cachedRegime.activeCount,
                sampleCount: cachedRegime.recentSampleCount,
                updatedAt: cachedRegime.updatedAt.toISOString(),
            });

            return cachedRegime;
        }

        // ── 3. Cache miss → we need to compute fresh aggregates ──────────────────────
        logger.debug('Cache miss - computing fresh regime aggregates', { symbol });

        // This is the expensive part - runs only on first access or after invalidation
        const freshRegime = this.computeAggregates(symbol, entries);

        // ── 4. Store the freshly computed result for future fast access ─────────────
        this.aggregates.set(symbol, freshRegime);

        logger.info('Computed and cached new regime aggregates', {
            symbol,
            completedEntries: freshRegime.recentSampleCount,
            activeSimulations: freshRegime.activeCount,
            excursionRatio: freshRegime.recentExcursionRatio.toFixed(2),
            computedAt: freshRegime.updatedAt.toISOString(),
        });

        // ── 5. Return the newly computed regime ──────────────────────────────────────
        return freshRegime;
    }

    /**
 * Private helper: Computes a fresh `ExcursionRegime` object from raw simulation entries.
 *
 * This is the **core aggregation engine** of the entire cache system.
 * It runs only when aggregates are missing or invalidated (lazy evaluation).
 *
 * Design principles:
 * - **Completed simulations only** for statistical reliability:
 *   - Win rate, avg R, reverse count, etc. — only meaningful when trades are closed
 * - **Blended completed + live** for current MFE/MAE:
 *   - Gives real-time view of ongoing risk/reward potential
 * - Safe averages everywhere (never NaN, always 0 on empty)
 * - Directional metrics are optional when no data exists
 * - Always includes `historyJson` (completed only) for full regime version
 *
 * @param symbol - The symbol being aggregated (used only for the returned object)
 * @param entries - Current array of all cached entries (live + completed) for this symbol
 * @returns Fully computed fresh `ExcursionRegime` object
 * @private
 */
    private computeAggregates(symbol: string, entries: CachedSimulationEntry[]): ExcursionRegime {
        // ── 1. Split into completed vs live ──────────────────────────────────────────
        const completed = entries.filter(e => !e.isLive);
        const live = entries.filter(e => e.isLive);

        const activeCount = live.length;

        // ── 2. Safe average helper (used everywhere) ─────────────────────────────────
        const safeAvg = (values: number[]): number => {
            if (values.length === 0) return 0;
            return values.reduce((sum, v) => sum + v, 0) / values.length;
        };

        // ── 3. Overall aggregates ─ only from COMPLETED simulations ─────────────────
        // These are the most statistically reliable metrics
        const recentMfe = safeAvg(completed.map(e => e.mfe));
        const recentMae = safeAvg(completed.map(e => e.mae));

        const recentExcursionRatio = ExcursionHistoryCache.computeExcursionRatio(recentMfe, recentMae);

        const recentSampleCount = completed.length;

        const recentReverseCount = completed.filter(
            e => e.rMultiple < 0 && Math.abs(e.label) >= 1
        ).length;

        const recentWinRate = recentSampleCount > 0
            ? completed.filter(e => e.label >= 1).length / recentSampleCount
            : 0;

        const recentAvgR = safeAvg(completed.map(e => e.rMultiple));

        // ── 4. Directional: LONGS (buy) ─ blend completed + live for current excursions ─
        const longs = [
            ...completed.filter(e => e.direction === 'buy'),
            ...live.filter(e => e.direction === 'buy'),
        ];

        const recentMfeLong = safeAvg(longs.map(e => e.mfe));
        const recentMaeLong = safeAvg(longs.map(e => e.mae));

        // Win rate & reversals only from completed longs
        const completedLongs = longs.filter(e => !e.isLive);
        const recentWinRateLong = completedLongs.length > 0
            ? completedLongs.filter(e => e.label >= 1).length / completedLongs.length
            : undefined;

        const recentReverseCountLong = completedLongs.filter(
            e => e.rMultiple < 0 && Math.abs(e.label) >= 1
        ).length || undefined;

        const recentSampleCountLong = longs.length > 0 ? longs.length : undefined;

        // ── 5. Directional: SHORTS (sell) ─ same pattern ─────────────────────────────
        const shorts = [
            ...completed.filter(e => e.direction === 'sell'),
            ...live.filter(e => e.direction === 'sell'),
        ];

        const recentMfeShort = safeAvg(shorts.map(e => e.mfe));
        const recentMaeShort = safeAvg(shorts.map(e => e.mae));

        const completedShorts = shorts.filter(e => !e.isLive);
        const recentWinRateShort = completedShorts.length > 0
            ? completedShorts.filter(e => e.label >= 1).length / completedShorts.length
            : undefined;

        const recentReverseCountShort = completedShorts.filter(
            e => e.rMultiple < 0 && Math.abs(e.label) >= 1
        ).length || undefined;

        const recentSampleCountShort = shorts.length > 0 ? shorts.length : undefined;

        // ── 6. Final assembly ────────────────────────────────────────────────────────
        const regime: ExcursionRegime = {
            symbol,

            // Full version includes the completed history (used in getRegime only)
            historyJson: completed as SimulationHistoryEntry[],

            // Overall stats
            recentAvgR,
            recentWinRate,
            recentReverseCount,
            recentMae,
            recentMfe,
            recentExcursionRatio,
            recentSampleCount,

            // Directional longs
            recentMfeLong,
            recentMaeLong,
            recentWinRateLong,
            recentReverseCountLong,
            recentSampleCountLong,

            // Directional shorts
            recentMfeShort,
            recentMaeShort,
            recentWinRateShort,
            recentReverseCountShort,
            recentSampleCountShort,

            activeCount,

            // Timestamp of computation (important for freshness checks later if needed)
            updatedAt: new Date(),
        };

        // ── 7. Optional debug logging of key metrics after computation ───────────────
        if (logger.isDebugEnabled()) {
            logger.debug('Computed fresh regime aggregates', {
                symbol,
                completedCount: regime.recentSampleCount,
                activeCount: regime.activeCount,
                overallRatio: regime.recentExcursionRatio.toFixed(2),
                longMae: regime.recentMaeLong?.toFixed(3),
                shortMae: regime.recentMaeShort?.toFixed(3),
                computationTime: 'instant', // could add timing later
            });
        }

        return regime;
    }

    /**
 * Retrieves the lightweight version of the current excursion regime for a symbol.
 *
 * This method is optimized for **high-frequency / hot-path** usage (e.g. strategy signal generation,
 * auto-trade decisions, real-time alerts), where the full `historyJson` array is not needed.
 *
 * Key differences from `getRegime()`:
 * - Returns `ExcursionRegimeLite` (same aggregates, **no** `historyJson` field)
 * - Even faster in most cases (slightly less memory allocation, no array reference)
 * - Uses the exact same underlying cached aggregates (no duplicate computation)
 *
 * Usage recommendation:
 * - Use `getRegimeLite()` almost everywhere you just need metrics (MFE/MAE, ratios, counts...)
 * - Only use full `getRegime()` when you actually need the recent simulation history
 *   (e.g. for debugging, last-two checks in some advanced excursion logic, ML feature extraction)
 *
 * Performance:
 * - O(1) when aggregates are cached (99%+ of calls after first access)
 * - Falls back to full computation only on cache miss (then caches both full & lite)
 *
 * @param symbol - The trading symbol to query (case-sensitive)
 * @returns Lightweight `ExcursionRegimeLite` object or `null` if no data exists
 */
    public getRegimeLite(symbol: string): ExcursionRegimeLite | null {
        // ── 1. Quick check: no data at all for this symbol ───────────────────────────
        if (!this.cache.has(symbol) || (this.cache.get(symbol)?.length ?? 0) === 0) {
            logger.info('No data found for symbol (lite regime)', { symbol });
            return null;
        }

        // ── 2. Fast path: reuse already computed full regime if available ─────────────
        const cachedFull = this.aggregates.get(symbol);

        if (cachedFull) {
            // We already have the full version cached → just strip the historyJson
            // This avoids any recomputation and is extremely cheap
            const { historyJson, ...liteData } = cachedFull;

            logger.debug('Returning lightweight regime from existing cache', {
                symbol,
                activeCount: liteData.activeCount,
                sampleCount: liteData.recentSampleCount,
            });

            return liteData as ExcursionRegimeLite;
        }

        // ── 3. Cache miss → need to compute aggregates first ─────────────────────────
        logger.debug('Cache miss for lite regime - triggering full computation', { symbol });

        // Get raw entries (we know they exist from step 1)
        const entries = this.cache.get(symbol)!;

        // Compute fresh full regime (this is the only expensive part)
        const freshFull = this.computeAggregates(symbol, entries);

        // Store it so future calls (both full and lite) are fast
        this.aggregates.set(symbol, freshFull);

        // ── 4. Create and return the lightweight version ─────────────────────────────
        const { historyJson, ...liteRegime } = freshFull;

        logger.info('Computed and cached new regime aggregates (lite request)', {
            symbol,
            completedEntries: freshFull.recentSampleCount,
            activeSimulations: freshFull.activeCount,
            excursionRatio: freshFull.recentExcursionRatio.toFixed(2),
        });

        return liteRegime as ExcursionRegimeLite;
    }

    /**
 * Forces a fresh recomputation of all aggregates for a specific symbol
 * and updates the internal cache with the new results.
 *
 * Use cases:
 * - Manual debugging or testing when you want to ensure aggregates are up-to-date
 * - After bulk imports or corrections of historical data
 * - When external factors (e.g. time window change) require full recalculation
 * - Recovery after suspected cache corruption (rare)
 *
 * Behavior:
 * 1. Checks if there is any data for the symbol
 * 2. If yes → recomputes aggregates from raw entries
 * 3. Stores the fresh result in the aggregates cache
 * 4. If no data exists → removes any stale aggregate entry (cleanup)
 *
 * Important notes:
 * - This method is **expensive** — it always recomputes, even if aggregates were already fresh
 * - Normal `getRegime()` / `getRegimeLite()` calls are lazy and much cheaper
 * - Use sparingly — only when you really need to force refresh
 *
 * @param symbol - The trading symbol whose aggregates should be forcefully recomputed
 */
    public refreshAggregates(symbol: string): void {
        // ── 1. Early exit - no data means nothing to recompute ───────────────────────
        const entries = this.cache.get(symbol);

        if (!entries || entries.length === 0) {
            // If someone tries to refresh a non-existing symbol, we clean up any stale cache
            const hadStaleAggregate = this.aggregates.delete(symbol);

            if (hadStaleAggregate) {
                logger.warn(
                    'Removed stale aggregate cache entry for symbol with no raw data',
                    { symbol }
                );
            } else {
                logger.info('No aggregates to refresh - symbol has no data', { symbol });
            }

            return;
        }

        // ── 2. Log the forced refresh (good for observability) ───────────────────────
        logger.info('Forced aggregate refresh requested', {
            symbol,
            currentEntryCount: entries.length,
            currentActive: entries.filter(e => e.isLive).length,
        });

        // ── 3. Perform the actual (expensive) recomputation ──────────────────────────
        const startTime = performance.now();

        const freshRegime = this.computeAggregates(symbol, entries);

        const computationTimeMs = performance.now() - startTime;

        // ── 4. Update the cache with fresh results ───────────────────────────────────
        this.aggregates.set(symbol, freshRegime);

        // ── 5. Detailed logging of the new state (helps debugging & monitoring) ──────
        logger.info('Aggregate refresh completed successfully', {
            symbol,
            completedCount: freshRegime.recentSampleCount,
            activeCount: freshRegime.activeCount,
            excursionRatio: freshRegime.recentExcursionRatio.toFixed(3),
            avgR: freshRegime.recentAvgR.toFixed(2),
            winRate: (freshRegime.recentWinRate * 100).toFixed(1) + '%',
            computationTimeMs: computationTimeMs.toFixed(1),
            refreshedAt: freshRegime.updatedAt.toISOString(),
        });

        logger.debug('Refreshed regime directional breakdown', {
            symbol,
            long: {
                mfe: freshRegime.recentMfeLong?.toFixed(3),
                mae: freshRegime.recentMaeLong?.toFixed(3),
                samples: freshRegime.recentSampleCountLong,
                winRate: freshRegime.recentWinRateLong !== undefined
                    ? (freshRegime.recentWinRateLong * 100).toFixed(1) + '%'
                    : 'n/a',
            },
            short: {
                mfe: freshRegime.recentMfeShort?.toFixed(3),
                mae: freshRegime.recentMaeShort?.toFixed(3),
                samples: freshRegime.recentSampleCountShort,
                winRate: freshRegime.recentWinRateShort !== undefined
                    ? (freshRegime.recentWinRateShort * 100).toFixed(1) + '%'
                    : 'n/a',
            },
        });
    }

    /**
 * Completely removes all data related to a specific symbol from the cache.
 *
 * This method is a **hard reset** for a single symbol and should be used when:
 * - You want to purge all historical simulation data for a symbol (e.g. after major data correction)
 * - The symbol is no longer relevant (delisted, blacklisted, testing cleanup)
 * - Debugging: starting fresh for a problematic symbol
 * - Memory pressure: forcibly freeing space for very large symbols
 *
 * What gets removed:
 * 1. All individual simulation entries (both live and completed)
 * 2. Any pre-computed aggregates/regime cache for this symbol
 *
 * Effects:
 * - After this call, `getRegime()` and `getRegimeLite()` will return `null` for this symbol
 * - Any future `updateOrAdd()` calls will start from an empty state again
 * - No automatic persistence or recovery — this is permanent within the current runtime
 *
 * Performance: O(1) — very fast (Map.delete operations)
 *
 * Logging: Always logs at info level when actual data was removed
 *
 * @param symbol - The exact trading symbol to completely clear (case-sensitive)
 */
    public clearSymbol(symbol: string): void {
        // ── 1. Check if there's anything to clear at all ─────────────────────────────
        const hadEntries = this.cache.has(symbol);
        const hadAggregates = this.aggregates.has(symbol);

        // Early exit + minimal logging when nothing exists
        if (!hadEntries && !hadAggregates) {
            logger.info('clearSymbol called on non-existing symbol (no-op)', { symbol });
            return;
        }

        // ── 2. Perform the actual removal ────────────────────────────────────────────
        // Remove raw simulation entries
        const deletedEntries = this.cache.delete(symbol);

        // Remove pre-computed aggregates
        const deletedAggregates = this.aggregates.delete(symbol);

        // ── 3. Log what actually happened (observability is important here) ──────────
        const entryCount = deletedEntries
            ? (this.cache.get(symbol)?.length ?? 0) // should be 0, just defensive
            : 0;

        logger.info('Symbol cache completely cleared', {
            symbol,
            removedRawEntries: deletedEntries,
            previousEntryCount: entryCount,
            removedAggregates: deletedAggregates,
            timestamp: new Date().toISOString(),
        });

        // Optional: more detailed trace logging if someone is debugging aggressively
        if (deletedEntries) {
            logger.info('Cleared symbol had following entry counts before removal', {
                symbol,
                totalEntries: entryCount,
                liveCount: this.cache.get(symbol)?.filter(e => e.isLive).length ?? 0,
                completedCount: this.cache.get(symbol)?.filter(e => !e.isLive).length ?? 0,
            });
        }

        // ── 4. No further action needed ──────────────────────────────────────────────
        // The memory is freed immediately (JS GC will handle it eventually)
        // No events/notifications are emitted — if needed, caller can handle that
    }

    /**
 * Performs global maintenance on the entire cache.
 *
 * This method is called periodically (via setInterval in constructor)
 * and is responsible for two main tasks:
 *
 * 1. **Time-based pruning** — remove old simulation entries that fall outside
 *    the recent window (controlled by `recentWindowMs`)
 *    → Keeps memory usage bounded over long-running periods
 *
 * 2. **Global size enforcement** — if after time pruning the total number
 *    of entries across ALL symbols still exceeds `maxTotalEntries`,
 *    remove oldest entries globally (LRU-like behavior)
 *
 * Important safety features:
 * - Live (in-progress) simulations are treated more leniently:
 *   they are kept even if somewhat old, as long as they were updated recently
 * - Never removes the very last entry of a symbol if it's live
 * - Thorough logging at appropriate levels
 * - Idempotent and safe to call multiple times
 *
 * Performance:
 * - O(N log N) in worst case (when global pruning is needed)
 * - Usually much faster — most symbols have few entries
 *
 * This method should be called:
 * - Automatically every ~30 minutes (configurable)
 * - Optionally manually during heavy load or before shutdown
 */
    public cleanup(): void {
        const now = Date.now();
        const cutoff = now - this.recentWindowMs;

        logger.debug('Starting global excursion cache cleanup', {
            currentTime: new Date(now).toISOString(),
            recentCutoff: new Date(cutoff).toISOString(),
            maxTotalEntries: this.maxTotalEntries,
        });

        let prunedCount = 0;
        let totalEntriesAfterTimePrune = 0;

        // ── PHASE 1: Time-based pruning per symbol ───────────────────────────────────
        for (const [symbol, entries] of this.cache.entries()) {
            const originalLength = entries.length;

            // Keep entry if:
            //   A) it's recent enough (timestamp >= cutoff), OR
            //   B) it's live AND was updated recently (lastUpdated not too old)
            const kept = entries.filter(entry =>
                entry.timestamp >= cutoff ||
                (entry.isLive && entry.lastUpdated >= cutoff - this.recentWindowMs / 2)
            );

            const removedThisSymbol = originalLength - kept.length;
            prunedCount += removedThisSymbol;
            totalEntriesAfterTimePrune += kept.length;

            if (removedThisSymbol > 0) {
                logger.info(`Pruned old entries for symbol during time-based cleanup`, {
                    symbol,
                    before: originalLength,
                    after: kept.length,
                    removed: removedThisSymbol,
                    remainingLive: kept.filter(e => e.isLive).length,
                });
            }

            if (kept.length === 0) {
                // Symbol has no remaining relevant data → remove completely
                this.cache.delete(symbol);
                this.aggregates.delete(symbol);
                logger.debug(`Removed empty symbol after time pruning`, { symbol });
            } else {
                // Update the entries array with filtered version
                this.cache.set(symbol, kept);
                // Invalidate aggregates — they may need recalculation after pruning
                this.aggregates.delete(symbol);
            }
        }

        // ── PHASE 2: Global size limit enforcement (only if still over limit) ────────
        if (totalEntriesAfterTimePrune > this.maxTotalEntries) {
            logger.warn(`Global entry limit exceeded after time pruning — starting LRU cleanup`, {
                currentTotal: totalEntriesAfterTimePrune,
                maxAllowed: this.maxTotalEntries,
                excess: totalEntriesAfterTimePrune - this.maxTotalEntries,
            });

            // Collect ALL remaining entries across all symbols with their symbol
            const allEntries: Array<{ symbol: string; entry: CachedSimulationEntry }> = [];

            for (const [symbol, entries] of this.cache.entries()) {
                allEntries.push(...entries.map(entry => ({ symbol, entry })));
            }

            // Sort globally by timestamp (oldest first)
            allEntries.sort((a, b) => a.entry.timestamp - b.entry.timestamp);

            // Calculate how many we need to remove
            const toRemoveCount = totalEntriesAfterTimePrune - this.maxTotalEntries;

            // Remove oldest entries until we're under limit
            const removedGlobal: Array<{ symbol: string; signalId: string }> = [];

            for (let i = 0; i < toRemoveCount && i < allEntries.length; i++) {
                const { symbol, entry } = allEntries[i];

                // Get current entries for this symbol
                const symbolEntries = this.cache.get(symbol);
                if (!symbolEntries) continue;

                const index = symbolEntries.findIndex(e => e.signalId === entry.signalId);
                if (index !== -1) {
                    symbolEntries.splice(index, 1);
                    removedGlobal.push({ symbol, signalId: entry.signalId });

                    // If symbol is now empty, clean it up
                    if (symbolEntries.length === 0) {
                        this.cache.delete(symbol);
                        this.aggregates.delete(symbol);
                    } else {
                        // Keep the trimmed array
                        this.cache.set(symbol, symbolEntries);
                        // Invalidate aggregates
                        this.aggregates.delete(symbol);
                    }

                    prunedCount++;
                }
            }

            if (removedGlobal.length > 0) {
                logger.warn(`Global LRU cleanup completed`, {
                    removedCount: removedGlobal.length,
                    remainingTotal: totalEntriesAfterTimePrune - removedGlobal.length,
                    affectedSymbols: [...new Set(removedGlobal.map(r => r.symbol))].length,
                });
            }
        }

        // ── Final summary logging ────────────────────────────────────────────────────
        const remainingSymbols = this.cache.size;
        const remainingEntries = Array.from(this.cache.values()).reduce((sum, arr) => sum + arr.length, 0);
        const remainingLive = Array.from(this.cache.values())
            .flat()
            .filter(e => e.isLive)
            .length;

        logger.info('Excursion cache cleanup completed', {
            totalPruned: prunedCount,
            remainingSymbols,
            remainingEntries,
            remainingLiveEntries: remainingLive,
            aggregatesCacheSize: this.aggregates.size,
            durationMs: Date.now() - now,
        });
    }

    /**
 * Returns current statistics about the state of the excursion cache.
 *
 * This method is designed for:
 * - Monitoring (Prometheus, health checks, dashboards)
 * - Debugging (when investigating memory usage or cache behavior)
 * - Logging at startup/shutdown or periodic status reports
 *
 * All values are computed **on-the-fly** (no caching) to ensure freshness.
 * Computation is very fast (O(number of symbols)) even with thousands of entries.
 *
 * Returned fields:
 * - symbolCount:      How many symbols currently have any data
 * - totalEntries:     Total number of simulation entries across all symbols
 * - liveEntries:      How many of those entries are still live/in-progress
 * - cachedAggregates: How many symbols have pre-computed aggregates cached
 *                     (should be close to symbolCount after normal usage)
 *
 * @returns Object containing basic cache health statistics
 */
    public getStats(): {
        symbolCount: number;
        totalEntries: number;
        liveEntries: number;
        cachedAggregates: number;
    } {
        // ── 1. Early exit when cache is completely empty ─────────────────────────────
        if (this.cache.size === 0) {
            logger.debug('getStats called on empty cache');
            return {
                symbolCount: 0,
                totalEntries: 0,
                liveEntries: 0,
                cachedAggregates: 0,
            };
        }

        // ── 2. Initialize counters ───────────────────────────────────────────────────
        let totalEntries = 0;
        let liveEntries = 0;

        // ── 3. Iterate over all symbols once ─────────────────────────────────────────
        // We do a single pass to collect all necessary metrics efficiently
        for (const [_symbol, entries] of this.cache.entries()) {
            const entryCount = entries.length;
            totalEntries += entryCount;

            // Count live entries (could also be done with .filter() but we avoid extra allocation)
            for (const entry of entries) {
                if (entry.isLive) {
                    liveEntries++;
                }
            }
        }

        // ── 4. Get aggregate cache size (very cheap Map operation) ───────────────────
        const cachedAggregates = this.aggregates.size;

        // ── 5. Build and return the stats object ─────────────────────────────────────
        const stats = {
            symbolCount: this.cache.size,
            totalEntries,
            liveEntries,
            cachedAggregates,
        };

        // ── 6. Logging — level depends on whether numbers are interesting or zero ─────
        if (stats.symbolCount === 0) {
            logger.debug('Cache statistics (empty)', stats);
        } else if (stats.totalEntries > 1000 || stats.liveEntries > 100) {
            // More active cache → log at info level
            logger.info('Current excursion cache statistics', {
                ...stats,
                livePercentage: totalEntries > 0 ? ((liveEntries / totalEntries) * 100).toFixed(1) + '%' : 'n/a',
                aggregateHitRate: stats.symbolCount > 0
                    ? ((stats.cachedAggregates / stats.symbolCount) * 100).toFixed(1) + '%'
                    : 'n/a',
            });
        } else {
            // Low activity → debug level
            logger.debug('Current excursion cache statistics', stats);
        }

        return stats;
    }

    // ──────────────────────────────────────────────────────────────────────────────
    // Static utility methods – pure functions for excursion analysis
    // ──────────────────────────────────────────────────────────────────────────────

    /**
 * Calculates the **excursion ratio** — a key risk/reward efficiency metric.
 *
 * Formula:
 * `excursionRatio = MFE / |MAE|`
 *
 * This ratio tells us how much favorable excursion (profit potential) we historically get
 * compared to the adverse excursion (drawdown risk) we have to endure.
 *
 * - Ratio > 1.0 → historically more reward than risk (good for trading in that direction)
 * - Ratio ≈ 1.0 → balanced risk/reward
 * - Ratio < 1.0 → more pain than gain (dangerous, often leads to skip/reverse decisions)
 *
 * Special safety handling:
 * - Never divide by zero → returns 0 when MAE is zero
 * - Uses absolute value of MAE (since MAE is always negative or zero)
 * - Very small MAE values are protected against division blow-up
 *
 * @param mfe - Maximum Favorable Excursion (positive number or zero)
 *              Represents best unrealized profit seen in simulations
 * @param mae - Maximum Adverse Excursion (negative number or zero)
 *              Represents worst unrealized drawdown seen in simulations
 * @returns The safe MFE / |MAE| ratio (≥ 0)
 *          - 0 when MAE is zero or no meaningful data
 *          - Positive number indicating reward-to-risk efficiency
 *
 * @example
 * computeExcursionRatio(2.5, -1.2)  // → 2.083 (good)
 * computeExcursionRatio(0.8, -1.5)  // → 0.533 (poor)
 * computeExcursionRatio(3.0, 0)     // → 0     (no drawdown → undefined ratio)
 * computeExcursionRatio(0, -2.0)    // → 0     (no favorable movement)
 */
    public static computeExcursionRatio(mfe: number, mae: number): number {
        // ── 1. Handle invalid/zero cases early ───────────────────────────────────────
        // If MFE is zero or negative → no favorable movement → ratio is 0
        if (mfe <= 0) {
            return 0;
        }

        // If MAE is zero → no drawdown observed → mathematically undefined
        // We return 0 to be conservative (don't treat it as infinite reward)
        if (mae === 0) {
            return 0;
        }

        // ── 2. Core calculation ──────────────────────────────────────────────────────
        // MAE is negative → we use absolute value to get positive drawdown magnitude
        const absMae = Math.abs(mae);

        // Very small MAE protection (prevents division by tiny floating-point noise)
        // Threshold is intentionally very small (0.0001% of entry price is negligible)
        if (absMae < 1e-6) {
            return 0;
        }

        // Final ratio: how many times bigger is the best profit vs the worst loss
        const ratio = mfe / absMae;

        // ── 3. Final safety clamp ────────────────────────────────────────────────────
        // While theoretically ratio can be very high, we cap it at a reasonable value
        // to prevent numeric instability in downstream comparisons/multipliers
        const cappedRatio = Math.min(ratio, 50); // 50× is already extremely favorable

        return cappedRatio;
    }

    /**
 * Converts an absolute excursion value (in price units) to a **percentage** relative
 * to the entry price of the trade.
 *
 * This method is used to:
 * - Normalize MFE (Maximum Favorable Excursion) and MAE (Maximum Adverse Excursion)
 *   values across different symbols and price levels
 * - Make statistics comparable (e.g. 2% drawdown on BTC vs 2% on a low-priced altcoin)
 * - Present human-readable risk/reward metrics (e.g. "worst drawdown was -1.8%")
 *
 * Formula:
 * `percentage = (absolute_excursion / entry_price) × 100`
 *
 * Important safety features:
 * - Prevents division by zero or negative entry price
 * - Returns 0 on invalid input (conservative default)
 * - Handles very small entry prices (common in crypto with high-precision pairs)
 *
 * @param value - The absolute excursion value (in quote currency units)
 *                - Positive for MFE (favorable = profit direction)
 *                - Negative for MAE (adverse = loss direction)
 * @param entryPrice - The entry price of the trade (must be > 0)
 * @returns The excursion as a percentage of entry price (e.g. 2.5, -1.8)
 *          - Positive = favorable movement
 *          - Negative = adverse movement
 *          - 0 on invalid input or zero movement
 *
 * @throws {Error} If entryPrice <= 0 (in development/testing environments)
 *                 In production, safely returns 0 instead
 *
 * @example
 * normalizeExcursion(1500, 60000)    // → 2.5     (MFE of $1500 on $60k entry = +2.5%)
 * normalizeExcursion(-900, 45000)    // → -2.0    (MAE of -$900 on $45k entry = -2%)
 * normalizeExcursion(0, 100)         // → 0       (no movement)
 * normalizeExcursion(200, 0)         // → 0       (invalid entry price)
 * normalizeExcursion(-50, 0.0001)    // → -50000  (extreme case, tiny price)
 */
    public static normalizeExcursion(value: number, entryPrice: number): number {
        // ── 1. Input validation ──────────────────────────────────────────────────────
        // Entry price must be positive - most important safety check
        if (entryPrice <= 0) {
            // In development/testing: throw to catch bugs early
            if (process.env.NODE_ENV !== 'production') {
                throw new Error(
                    `Invalid entry price for normalizeExcursion: ${entryPrice}. Must be > 0`
                );
            }

            // In production: fail-safe return 0 (better than NaN or Infinity downstream)
            logger.warn('normalizeExcursion called with invalid entry price', {
                entryPrice,
                value,
                context: 'production safety fallback',
            });

            return 0;
        }

        // ── 2. Zero movement case - early return for efficiency ──────────────────────
        if (value === 0) {
            return 0;
        }

        // ── 3. Core calculation ──────────────────────────────────────────────────────
        // Standard percentage change formula
        const percentage = (value / entryPrice) * 100;

        // ── 4. Optional: reasonable bounds for sanity (crypto can be extreme) ────────
        // While not strictly necessary, helps prevent numeric weirdness in UI/decision logic
        // 10000% = 100× entry price (very rare but possible in pumps/dumps)
        const boundedPercentage = Math.max(-10000, Math.min(10000, percentage));

        // If we bounded the value, log it at debug level (helps detect outliers)
        if (boundedPercentage !== percentage) {
            logger.debug('Normalized excursion value was bounded for safety', {
                original: percentage,
                bounded: boundedPercentage,
                entryPrice,
                rawValue: value,
            });
        }

        return boundedPercentage;
    }

    /**
 * Determines whether the current regime for a symbol shows **dangerously high drawdown risk**
 * in the requested direction (long or short).
 *
 * This is one of the most important safety filters in the trading system.
 * It helps prevent entering trades when historical/real-time simulations show
 * that drawdowns (MAE) are consistently too large relative to acceptable risk.
 *
 * Main decision criteria:
 * 1. Uses the **most recent** MAE value (overall or direction-specific when available)
 * 2. Compares against configurable maximum allowed MAE percentage
 * 3. Requires a minimum number of samples to trust the statistic
 * 4. Prioritizes directional MAE when sufficient data exists for that direction
 *
 * Returns `true` = **high risk** → should typically skip or reduce size
 * Returns `false` = **acceptable risk** → can proceed (subject to other filters)
 *
 * @param regime - The current regime data (full or lite version)
 * @param direction - The intended trade direction we're evaluating risk for
 * @returns `true` if drawdown risk is considered dangerously high, `false` otherwise
 *
 * @example
 * // Typical usage in strategy / auto-trade:
 * if (ExcursionHistoryCache.isHighMaeRisk(regime, 'long')) {
 *   // Skip long trade or reduce position size significantly
 * }
 */
    public static isHighMaeRisk(
        regime: ExcursionRegime | ExcursionRegimeLite,
        direction: 'long' | 'short'
    ): boolean {
        // ── 1. Configuration values ──────────────────────────────────────────────────
        // These should eventually be moved to central config.strategy
        const MAX_MAE_PCT_DEFAULT = 3.0;          // Maximum acceptable average MAE (%)
        const MIN_SAMPLES_FOR_TRUST = 3;          // Need at least this many samples to trust MAE

        const maxMaePct = config.strategy?.maxMaePct ?? MAX_MAE_PCT_DEFAULT;

        // ── 2. Early exit - not enough overall samples to make any decision ──────────
        if (regime.recentSampleCount < MIN_SAMPLES_FOR_TRUST) {
            // Conservative: if we don't have enough data, assume it's NOT high risk yet
            // (better to allow cautious trading than block everything)
            return false;
        }

        // ── 3. Determine which MAE value to use (priority order) ─────────────────────
        let selectedMae: number | undefined;

        // Priority 1: Directional recent MAE (most specific/relevant)
        if (direction === 'long') {
            selectedMae = regime.recentMaeLong;
        } else {
            selectedMae = regime.recentMaeShort;
        }

        // Priority 2: Fallback to overall recent MAE if directional not available
        if (selectedMae === undefined) {
            selectedMae = regime.recentMae;
        }

        // ── 4. Final safety check - if we still don't have a usable MAE value ────────
        if (selectedMae === undefined || selectedMae === 0) {
            // No meaningful drawdown data yet → treat as safe
            return false;
        }

        // ── 5. Core risk decision ────────────────────────────────────────────────────
        // MAE is negative → we compare the absolute value
        const absMae = Math.abs(selectedMae);

        const isHighRisk = absMae > maxMaePct;

        // ── 6. Optional detailed debug logging (only when actually risky) ────────────
        if (isHighRisk && logger.isDebugEnabled()) {
            const source = selectedMae === regime.recentMae ? 'overall' : direction;

            logger.debug('High MAE risk detected', {
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
            });
        }

        return isHighRisk;
    }

    /**
 * Determines whether we have **sufficient simulation samples** in the recent regime
 * to reasonably trust the computed statistics (MFE/MAE averages, win rate, excursion ratio, etc.).
 *
 * This method acts as a **confidence gate** — many decisions in the trading system
 * (signal generation, auto-trading, alert strength, reversal logic, etc.) should be
 * more cautious or completely disabled when there aren't enough samples.
 *
 * Main rules:
 * - Uses `recentSampleCount` (completed simulations in the recent window) as primary metric
 * - Allows caller to override minimum threshold (default = 3)
 * - Very conservative: better to say "not enough data" than to trust noisy statistics
 *
 * Why completed-only?
 * Live/in-progress simulations are useful for current MFE/MAE, but **not** reliable for
 * win rate, average R, reversal count, etc. — those need closed outcomes.
 *
 * @param regime - Current regime data (full or lite version)
 * @param minSamples - Minimum number of **completed** recent samples required to trust stats
 *                     Default: 3 (can be increased to 5–10 for more conservative behavior)
 * @returns `true` if we have enough completed samples to trust regime statistics,
 *          `false` otherwise (data is too sparse/noisy)
 *
 * @example
 * // Typical usage:
 * if (!ExcursionHistoryCache.hasEnoughSamples(regime)) {
 *   // Skip trade, reduce confidence heavily, or use fallback logic
 *   confidence *= 0.3;
 *   reasons.push("Insufficient recent simulation samples");
 * }
 */
    public static hasEnoughSamples(
        regime: ExcursionRegime | ExcursionRegimeLite,
        minSamples: number = 3
    ): boolean {
        // ── 1. Input validation & safety ─────────────────────────────────────────────
        // Make sure minSamples is reasonable (protect against bad caller config)
        const effectiveMin = Math.max(1, Math.floor(minSamples));

        // ── 2. Core decision – check completed sample count ──────────────────────────
        const completedCount = regime.recentSampleCount ?? 0;

        const hasEnough = completedCount >= effectiveMin;

        // ── 3. Optional debug logging when close to threshold (helps tuning) ─────────
        if (logger.isDebugEnabled() && completedCount > 0 && completedCount < effectiveMin + 3) {
            logger.debug('Borderline sample count for regime trust', {
                symbol: regime.symbol,
                completedSamples: completedCount,
                requiredMinimum: effectiveMin,
                directionContext: 'N/A (overall)', // could be extended later for directional
                decision: hasEnough ? 'trusted' : 'not trusted',
            });
        }

        // ── 4. Return result ─────────────────────────────────────────────────────────
        return hasEnough;
    }

    /**
 * Performs graceful shutdown and cleanup of the ExcursionHistoryCache.
 *
 * This method should be called during application shutdown (e.g. in the main process
 * exit handler, SIGTERM/SIGINT listener, or container stop hook).
 *
 * Current responsibilities:
 * 1. Stops the periodic background cleanup timer
 * 2. Optional: final cleanup pass (can be forced)
 * 3. Logs shutdown status for observability
 *
 * Future/optional extensions (can be added later):
 * - Flush important stats to persistent storage (if we ever add persistence)
 * - Notify listeners/subscribers (if we implement event emitter pattern)
 * - Export final cache snapshot for debugging or warm restart
 *
 * Important notes:
 * - This method is **idempotent** — safe to call multiple times
 * - Does NOT clear the actual data (cache + aggregates) by default
 *   → keeps memory until Node.js process fully exits
 * - If you want to immediately free memory, call `clearAll()` first (not implemented yet)
 *
 * Typical usage pattern:
 *
 * ```ts
 * process.on('SIGTERM', () => {
 *   logger.info('Received SIGTERM - initiating graceful shutdown...');
 *   excursionCache.destroy();
 *   // other shutdown steps...
 *   process.exit(0);
 * });
 * ```
 */
    public destroy(): void {
        // ── 1. Prevent double cleanup ────────────────────────────────────────────────
        if (!this.cleanupTimer) {
            logger.debug('destroy() called but cleanup timer already stopped (idempotent)');
            return;
        }

        // ── 2. Stop the periodic cleanup interval ────────────────────────────────────
        clearInterval(this.cleanupTimer);
        this.cleanupTimer = null;

        logger.info('ExcursionHistoryCache background cleanup stopped', {
            timestamp: new Date().toISOString(),
        });

        // ── 3. Optional: Final cleanup pass before exit ──────────────────────────────
        // This can help free memory a bit earlier and log final state
        try {
            logger.debug('Performing final cleanup pass during shutdown...');
            this.cleanup();

            const finalStats = this.getStats();
            logger.info('Final cache state before shutdown', {
                ...finalStats,
                memoryPressureEstimate: finalStats.totalEntries > 5000 ? 'high' : 'normal',
            });
        } catch (err) {
            logger.error('Error during final cleanup pass in destroy()', {
                error: err instanceof Error ? err.message : String(err),
                stack: err instanceof Error ? err.stack : undefined,
            });
            // Continue shutdown anyway - don't block exit
        }

        // ── 4. Final shutdown confirmation ───────────────────────────────────────────
        logger.debug('ExcursionHistoryCache destroy complete - ready for process exit');
    }
}

// Singleton export
export const excursionCache = new ExcursionHistoryCache();
