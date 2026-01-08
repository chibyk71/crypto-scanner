// src/lib/services/excursionHistoryCache.ts
// =============================================================================
// EXCURSION HISTORY CACHE – PRODUCTION-GRADE IN-MEMORY STORE FOR SIMULATIONS
//
// Purpose:
//   • Centralized, high-performance cache for MFE/MAE excursion data from simulations
//   • Stores both live (in-progress) and completed simulations per symbol
//   • Provides real-time aggregate metrics (averages, ratios, win rates, directional stats)
//   • Designed for low-latency access in signal generation (called every scan)
//   • Memory-safe with bounded size, automatic pruning, and robust defaults
//   • Fully typed, observable, and maintainable
//
// Key Improvements Over Original:
//   • Incremental aggregate caching (avoid recomputing full arrays on every get)
//   • Strict bounds on entries per symbol and total cache size
//   • Safe arithmetic (no div-by-zero, NaN protection)
//   • Better live/completed blending with clear separation
//   • Enhanced logging and debuggability
//   • Immutable-style updates where possible
//   • Configurable via config.strategy
// =============================================================================

import { createLogger } from '../logger';
import { config } from '../config/settings';
import type { SimulationHistoryEntry } from '../../types/signalHistory';
import type { EnrichedSymbolHistory } from '../db';

const logger = createLogger('ExcursionCache');

// Internal cache entry – extends public type with runtime metadata
interface CachedSimulationEntry extends SimulationHistoryEntry {
    signalId: string;
    isLive: boolean;
    lastUpdated: number;  // Timestamp of last update (used for live staleness)
}

// Pre-computed aggregates per symbol (updated incrementally)
interface SymbolAggregates extends EnrichedSymbolHistory {
    activeCount: number;
}

export class ExcursionHistoryCache {
    // Core storage
    private readonly cache: Map<string, CachedSimulationEntry[]> = new Map();
    private readonly aggregates: Map<string, SymbolAggregates> = new Map();

    // Configuration
    private readonly recentWindowMs: number;
    private readonly maxEntriesPerSymbol: number;
    private readonly maxTotalEntries: number;
    private readonly cleanupIntervalMs = 30 * 60 * 1000; // 30 minutes

    constructor() {
        // Load config with sensible defaults
        this.recentWindowMs = (config.strategy.recentWindowHours ?? 3) * 60 * 60 * 1000;
        this.maxEntriesPerSymbol = 100;
        this.maxTotalEntries = 10_000;

        logger.info('ExcursionHistoryCache initialized', {
            recentWindowHours: config.strategy.recentWindowHours ?? 3,
            maxEntriesPerSymbol: this.maxEntriesPerSymbol,
            maxTotalEntries: this.maxTotalEntries,
        });

        // Start background cleanup
        setInterval(() => this.cleanup(), this.cleanupIntervalMs);
    }

    /**
     * Update or add a simulation entry (live or completed)
     * - Live updates: incrementally update MFE (max) and MAE (min)
     * - Completed: finalize and mark isLive = false
     * - Enforces max entries per symbol
     */
    public updateOrAdd(
        symbol: string,
        signalId: string,
        updates: Partial<Omit<CachedSimulationEntry, 'signalId' | 'isLive' | 'lastUpdated'>>,
        isLive: boolean = true
    ): void {
        let entries = this.cache.get(symbol);
        if (!entries) {
            entries = [];
            this.cache.set(symbol, entries);
        }

        const now = Date.now();
        const existingIdx = entries.findIndex(e => e.signalId === signalId);

        if (existingIdx !== -1) {
            // === UPDATE EXISTING ===
            const entry = entries[existingIdx];

            // Live MFE/MAE: take extreme values (best profit, worst drawdown)
            if (isLive) {
                if (updates.mfe !== undefined) {
                    entry.mfe = Math.max(entry.mfe ?? 0, updates.mfe);
                }
                if (updates.mae !== undefined) {
                    entry.mae = Math.min(entry.mae ?? 0, updates.mae);
                }
            }

            // Apply all other updates
            Object.assign(entry, updates);
            entry.isLive = isLive;
            entry.lastUpdated = now;

            logger.debug(`${isLive ? 'Live update' : 'Completed'} simulation`, { symbol, signalId });
        } else {
            // === ADD NEW ENTRY ===
            if (entries.length >= this.maxEntriesPerSymbol) {
                // Enforce limit: remove oldest (by timestamp)
                entries.sort((a, b) => a.timestamp - b.timestamp);
                entries.shift();
                logger.debug(`Pruned oldest entry for ${symbol} to enforce maxEntriesPerSymbol`);
            }

            const newEntry: CachedSimulationEntry = {
                signalId,
                isLive,
                lastUpdated: now,
                timestamp: updates.timestamp ?? now,
                direction: updates.direction ?? 'buy',
                outcome: updates.outcome ?? 'timeout',
                rMultiple: updates.rMultiple ?? 0,
                label: updates.label ?? 0,
                durationMs: updates.durationMs ?? 0,
                mfe: updates.mfe ?? 0,
                mae: updates.mae ?? 0,
                ...updates,
            };

            entries.push(newEntry);
            logger.debug(`Added new ${isLive ? 'live' : 'completed'} simulation`, { symbol, signalId });
        }

        // Invalidate and recompute aggregates for this symbol
        this.aggregates.delete(symbol);
    }

    /**
     * Compute fresh aggregates for a symbol (called only when cache miss)
     * - Safe averages with fallbacks
     * - Clear separation: win rate/reversals from completed only
     * - Directional stats blend live + completed for real-time MFE/MAE
     */
    private computeAggregates(symbol: string, entries: CachedSimulationEntry[]): SymbolAggregates {
        const completed = entries.filter(e => !e.isLive);
        const live = entries.filter(e => e.isLive);
        const activeCount = live.length;

        // Helper: safe average
        const safeAvg = (values: number[]) => {
            if (values.length === 0) return 0;
            return values.reduce((sum, v) => sum + v, 0) / values.length;
        };

        // Overall (completed only)
        const recentMfe = safeAvg(completed.map(e => e.mfe));
        const recentMae = safeAvg(completed.map(e => e.mae));
        const recentExcursionRatio = recentMfe / Math.max(Math.abs(recentMae), 1e-6);
        const recentSampleCount = completed.length;
        const recentReverseCount = completed.filter(e => e.rMultiple < 0 && Math.abs(e.label) >= 1).length;
        const recentWinRate = completed.filter(e => e.label >= 1).length / Math.max(recentSampleCount, 1);
        const recentAvgR = safeAvg(completed.map(e => e.rMultiple));

        // Directional: longs (blend completed + live)
        const longs = [...completed.filter(e => e.direction === 'buy'), ...live.filter(e => e.direction === 'buy')];
        const recentMfeLong = safeAvg(longs.map(e => e.mfe));
        const recentMaeLong = safeAvg(longs.map(e => e.mae));
        const completedLongs = longs.filter(e => !e.isLive);
        const recentWinRateLong = completedLongs.filter(e => e.label >= 1).length / Math.max(completedLongs.length, 1);
        const recentReverseCountLong = completedLongs.filter(e => e.rMultiple < 0 && Math.abs(e.label) >= 1).length;
        const recentSampleCountLong = longs.length;

        // Directional: shorts
        const shorts = [...completed.filter(e => e.direction === 'sell'), ...live.filter(e => e.direction === 'sell')];
        const recentMfeShort = safeAvg(shorts.map(e => e.mfe));
        const recentMaeShort = safeAvg(shorts.map(e => e.mae));
        const completedShorts = shorts.filter(e => !e.isLive);
        const recentWinRateShort = completedShorts.filter(e => e.label >= 1).length / Math.max(completedShorts.length, 1);
        const recentReverseCountShort = completedShorts.filter(e => e.rMultiple < 0 && Math.abs(e.label) >= 1).length;
        const recentSampleCountShort = shorts.length;

        const aggregates: SymbolAggregates = {
            symbol,
            historyJson: completed as SimulationHistoryEntry[],
            activeCount,
            recentAvgR,
            recentWinRate,
            recentReverseCount,
            recentMae,
            recentMfe,
            recentExcursionRatio,
            recentSampleCount,
            recentMfeLong,
            recentMaeLong,
            recentWinRateLong,
            recentReverseCountLong,
            recentSampleCountLong,
            recentMfeShort,
            recentMaeShort,
            recentWinRateShort,
            recentReverseCountShort,
            recentSampleCountShort,
            updatedAt: new Date(),
        };

        return aggregates;
    }

    /**
     * Get current regime for a symbol – cached when possible
     * Returns null only if no data at all
     */
    public getRegime(symbol: string): (EnrichedSymbolHistory & { activeCount: number }) | null {
        const entries = this.cache.get(symbol);

        if (!entries || entries.length === 0) {
            return null;
        }

        // Return cached aggregates if available
        const cached = this.aggregates.get(symbol);
        if (cached) {
            return cached;
        }

        // Compute fresh and cache
        const aggregates = this.computeAggregates(symbol, entries);
        this.aggregates.set(symbol, aggregates);
        return aggregates;
    }

    /**
     * Global cleanup: prune old entries and enforce total cache limit
     */
    public cleanup(): void {
        const now = Date.now();
        const cutoff = now - this.recentWindowMs;
        let prunedCount = 0;
        let totalEntries = 0;

        for (const [symbol, entries] of this.cache.entries()) {
            const originalLength = entries.length;

            // Keep: recent timestamp OR live and recently updated
            const kept = entries.filter(
                e => e.timestamp >= cutoff || (e.isLive && e.lastUpdated >= cutoff - this.recentWindowMs / 2)
            );

            prunedCount += originalLength - kept.length;
            totalEntries += kept.length;

            if (kept.length === 0) {
                this.cache.delete(symbol);
                this.aggregates.delete(symbol);
            } else {
                this.cache.set(symbol, kept);
                this.aggregates.delete(symbol); // Invalidate aggregates
            }
        }

        // Enforce global limit (LRU-style: prune oldest across all symbols if over)
        if (totalEntries > this.maxTotalEntries) {
            const allEntries: Array<{ symbol: string; entry: CachedSimulationEntry }> = [];
            for (const [symbol, entries] of this.cache.entries()) {
                allEntries.push(...entries.map(entry => ({ symbol, entry })));
            }

            allEntries.sort((a, b) => a.entry.timestamp - b.entry.timestamp);
            const toRemove = allEntries.slice(0, totalEntries - this.maxTotalEntries);

            for (const { symbol, entry } of toRemove) {
                const entries = this.cache.get(symbol)!;
                const idx = entries.findIndex(e => e.signalId === entry.signalId);
                if (idx !== -1) entries.splice(idx, 1);
                prunedCount++;
            }

            // Clean up empty symbols
            for (const symbol of this.cache.keys()) {
                if (this.cache.get(symbol)!.length === 0) {
                    this.cache.delete(symbol);
                    this.aggregates.delete(symbol);
                }
            }

            logger.warn(`Enforced global cache limit – pruned ${toRemove.length} excess entries`);
        }

        if (prunedCount > 0) {
            logger.info('Excursion cache cleanup completed', {
                prunedCount,
                remainingSymbols: this.cache.size,
                totalEntries: totalEntries - prunedCount,
            });
        }
    }

    // Debug / monitoring
    public getStats() {
        let total = 0;
        let live = 0;
        for (const entries of this.cache.values()) {
            total += entries.length;
            live += entries.filter(e => e.isLive).length;
        }
        return {
            symbolCount: this.cache.size,
            totalEntries: total,
            liveEntries: live,
            cachedAggregates: this.aggregates.size,
        };
    }
}

// Singleton export
export const excursionCache = new ExcursionHistoryCache();
