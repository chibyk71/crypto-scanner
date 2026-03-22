// src/lib/services/excursionHistoryCache.ts
// =============================================================================
// EXCURSION HISTORY CACHE – CENTRALIZED SOURCE OF TRUTH FOR SIMULATION METRICS
//
// Design:
//   • Completed simulations only — no live tracking
//   • Per-symbol: keeps last MAX_CLOSED_SIMS_PER_SYMBOL sims regardless of time,
//     plus a STALE_WINDOW_MS cap to discard genuinely ancient data
//   • Partial-trust mode for symbols with 1–2 side samples (instead of hard skip)
//   • Pure directional aggregates (buy / sell) — no combined MFE/MAE fallback
//   • historyJson capped at MAX_CLOSED_SIMS_PER_SYMBOL (was wrongly capped at 5)
//   • Scoring thresholds calibrated for 1m simulation candles / 10-min window
//
// Storage scaling (important — two ×1e4 multiplications produce effective ×1e8):
//   storeAndFinalizeSimulation passes: Math.round(boundedMfe * 1e4)
//   updateCompletedSimulation stores:  Math.round(value * 1e4)
//   Effective DB storage:              boundedMfe * 1e8
//   warmUpFromDb reads back with:      / 1e8  ← correct
//   Live addCompletedSimulation receives boundedMfe directly (no division needed)
// =============================================================================

import { createLogger } from '../logger';
import { config } from '../config/settings';
import type { SimulationHistoryEntry } from '../../types/signalHistory';
import type { SignalLabel, SimulationOutcome } from '../../types';
import type { SimulatedTrade } from '../db/schema';
import { dbService } from '../db';

const logger = createLogger('ExcursionCache');

// ──────────────────────────────────────────────────────────────────────────────
// Configuration constants
// ──────────────────────────────────────────────────────────────────────────────

// Hard cap on how old a sim can be before it's discarded regardless of count.
// 3h is a reasonable scalping regime window — market structure shifts in 2–4h.
const STALE_WINDOW_HOURS = 3;

// Max sims kept per symbol. Combined buy + sell, newest first.
const MAX_CLOSED_SIMS_PER_SYMBOL = 10;

// Minimum samples per side for full trust. Below this → partial trust (not skip).
const MIN_SAMPLES_FULL_TRUST = 3;

// Below this per side → hard skip. 0 means genuinely no data.
const MIN_SAMPLES_HARD_SKIP = 1;

type Direction = 'buy' | 'sell';
type LongShort = 'long' | 'short';

interface DirectionalAggregates {
    sampleCount: number;
    mfe: number;          // avg max favorable excursion (% of entry, positive)
    mae: number;          // avg max adverse excursion (% of entry, negative)
    excursionRatio: number;
    avgDurationMs: number;
    outcomeCounts: {
        tp: number;
        partial_tp: number;
        sl: number;
        timeout: number;
    };
    winRate?: number;
}

interface CachedSimulationEntry extends SimulationHistoryEntry {
    signalId: string;
    timestamp: number;
    direction: Direction;
    durationMs: number;
    timeToMFE_ms: number;
    timeToMAE_ms: number;
}

interface SimulationScore {
    baseScore: number;
    timeModifier: number;
    totalScore: number;
}

export interface ExcursionRegime {
    symbol: string;
    historyJson?: SimulationHistoryEntry[];
    recentSampleCount: number;
    slStreak: number;
    timeoutRatio: number;
    buy?: DirectionalAggregates;
    sell?: DirectionalAggregates;
    slStreakBuy?: number;
    slStreakSell?: number;
    activeCount: 0;
    updatedAt: Date;
}

export interface ExcursionRegimeLite extends Omit<ExcursionRegime, 'historyJson'> { }

// ──────────────────────────────────────────────────────────────────────────────
// Scoring thresholds — calibrated for 1m sim candles / 10-min window
// ──────────────────────────────────────────────────────────────────────────────
const SCORE_THRESHOLDS = {
    mfeGood: 0.5,               // % — strong favorable move
    mfeDecent: 0.3,               // % — decent favorable move (your target)
    maeMaxGood: 1.0,               // % — acceptable adverse
    ratioReverse: 0.6,               // MAE > MFE/0.6 → MAE dominates
    earlyTimeMs: 5 * 60 * 1000,     // 5 min — half the 10-min window
    fastCloseMs: 5 * 60 * 1000,     // resolved in first half = fast
    slowCloseMs: 8 * 60 * 1000,     // near timeout = slow
    earlyMfeBonusMs: 3 * 60 * 1000,     // MFE in first 3 candles = strong momentum
    rapidMaePenaltyMs: 3 * 60 * 1000,     // MAE in first 3 candles = dangerous
    lateMfePenaltyRatio: 0.7,               // MFE peak > 70% of duration = fading
};

export class ExcursionHistoryCache {
    private cache: Map<string, CachedSimulationEntry[]>;
    private aggregates: Map<string, ExcursionRegime>;

    private readonly staleWindowMs: number;
    private readonly maxClosedSims: number;
    private readonly cleanupIntervalMs: number = 30 * 60_000;

    private cleanupTimer: NodeJS.Timeout | null = null;

    constructor() {
        this.cache = new Map();
        this.aggregates = new Map();

        this.staleWindowMs = STALE_WINDOW_HOURS * 60 * 60 * 1000;
        this.maxClosedSims = MAX_CLOSED_SIMS_PER_SYMBOL;

        logger.info('ExcursionHistoryCache initialized', {
            staleWindowHours: STALE_WINDOW_HOURS,
            maxClosedSimsPerSymbol: this.maxClosedSims,
            cleanupIntervalMinutes: this.cleanupIntervalMs / 60_000,
            minSamplesFullTrust: MIN_SAMPLES_FULL_TRUST,
            minSamplesHardSkip: MIN_SAMPLES_HARD_SKIP,
        });

        this.cleanupTimer = setInterval(() => {
            try {
                this.cleanup();
            } catch (err) {
                logger.error('Periodic cleanup failed – continuing', {
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }, this.cleanupIntervalMs);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Scoring & labeling
    // ──────────────────────────────────────────────────────────────────────────

    public mapScoreToLabel(score: number): SignalLabel {
        if (score >= 4.0) return 2;
        if (score >= 3.0) return 1;
        if (score >= 2.0) return 0;
        if (score >= 1.0) return -1;
        return -2;
    }

    public computeSimulationScore(entry: Partial<CachedSimulationEntry>): SimulationScore {
        if (!entry || typeof entry !== 'object') {
            logger.warn('computeSimulationScore: invalid entry – returning 0');
            return { baseScore: 0, timeModifier: 0, totalScore: 0 };
        }

        const outcome = entry.outcome ?? 'timeout';
        const mfe = entry.mfe ?? 0;
        const absMae = Math.abs(entry.mae ?? 0);
        const durationMs = entry.durationMs ?? 0;
        const timeToMfeMs = entry.timeToMFE_ms ?? 0;
        const timeToMaeMs = entry.timeToMAE_ms ?? 0;

        // ── Base score ────────────────────────────────────────────────────────
        let baseScore = 0;

        if (outcome === 'tp' || outcome === 'partial_tp') {
            baseScore = 5.0;
        } else if (outcome === 'timeout') {
            if (mfe >= SCORE_THRESHOLDS.mfeGood && absMae < SCORE_THRESHOLDS.maeMaxGood) {
                baseScore = 4.5;
            } else if (mfe >= SCORE_THRESHOLDS.mfeDecent && absMae < SCORE_THRESHOLDS.maeMaxGood) {
                baseScore = 3.5;
            } else if (absMae > mfe / SCORE_THRESHOLDS.ratioReverse) {
                baseScore = 0.5;  // MAE dominates — reverse candidate
            } else {
                baseScore = 2.0;  // neutral timeout
            }
        } else if (outcome === 'sl') {
            if (mfe >= SCORE_THRESHOLDS.mfeGood && timeToMfeMs <= SCORE_THRESHOLDS.earlyTimeMs) {
                baseScore = 3.0;  // early MFE then trapped — some momentum
            } else if (mfe >= SCORE_THRESHOLDS.mfeDecent) {
                baseScore = 2.0;
            } else {
                baseScore = 0.0;  // clean loss — strong reverse sign
            }
        }

        // ── Magnitude-gated time modifiers ────────────────────────────────────
        let timeModifier = 0;

        if (durationMs <= SCORE_THRESHOLDS.fastCloseMs && outcome !== 'sl') timeModifier += 1.0;
        if (durationMs > SCORE_THRESHOLDS.slowCloseMs) timeModifier -= 0.5;

        if (timeToMfeMs <= SCORE_THRESHOLDS.earlyMfeBonusMs && mfe >= SCORE_THRESHOLDS.mfeGood) {
            timeModifier += 0.8;
        }

        if (timeToMaeMs <= SCORE_THRESHOLDS.rapidMaePenaltyMs && absMae >= SCORE_THRESHOLDS.mfeGood) {
            timeModifier -= 1.0;
        }

        if (timeToMfeMs > durationMs * SCORE_THRESHOLDS.lateMfePenaltyRatio && mfe >= SCORE_THRESHOLDS.mfeGood) {
            timeModifier -= 0.5;
        }

        timeModifier = Math.max(-1.5, Math.min(1.8, timeModifier));

        const totalScore = Math.max(0, Math.min(5, baseScore + timeModifier));
        return { baseScore, timeModifier, totalScore };
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Write path
    // ──────────────────────────────────────────────────────────────────────────

    public addCompletedSimulation(symbol: string, entry: Partial<CachedSimulationEntry>): void {
        if (!entry || typeof entry !== 'object') {
            logger.warn('addCompletedSimulation: invalid entry – rejected');
            return;
        }

        symbol = symbol.trim().toUpperCase();
        if (!symbol) {
            logger.warn('addCompletedSimulation: empty symbol – rejected');
            return;
        }

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
            logger.warn('addCompletedSimulation: incomplete entry – rejected', {
                symbol, signalId: entry.signalId ?? 'unknown', missingFields,
            });
            return;
        }

        const validated = entry as CachedSimulationEntry;

        // Timing sanity — warn but still accept
        if (
            validated.durationMs < 0 ||
            validated.timeToMFE_ms < 0 ||
            validated.timeToMAE_ms < 0 ||
            validated.timeToMFE_ms > validated.durationMs ||
            validated.timeToMAE_ms > validated.durationMs
        ) {
            logger.warn('addCompletedSimulation: suspicious timing values', {
                symbol, signalId: validated.signalId,
                durationMs: validated.durationMs,
                timeToMFE_ms: validated.timeToMFE_ms,
                timeToMAE_ms: validated.timeToMAE_ms,
            });
        }

        const { totalScore } = this.computeSimulationScore(validated);
        const label = this.mapScoreToLabel(totalScore);

        const enriched = { ...validated, score: totalScore, label };

        let sims = this.cache.get(symbol) ?? [];
        sims.push(enriched);
        sims.sort((a, b) => b.timestamp - a.timestamp);

        // Prune by staleness first, then cap by count
        const stalecut = Date.now() - this.staleWindowMs;
        sims = sims.filter(s => s.timestamp >= stalecut);
        if (sims.length > this.maxClosedSims) {
            sims = sims.slice(0, this.maxClosedSims);
        }

        if (sims.length === 0) {
            this.cache.delete(symbol);
            this.aggregates.delete(symbol);
        } else {
            this.cache.set(symbol, sims);
            this.recomputeAggregates(symbol);
        }

        logger.info('Simulation added to cache', {
            symbol, signalId: validated.signalId,
            direction: validated.direction, outcome: validated.outcome,
            score: totalScore.toFixed(2), label, cacheSize: sims.length,
        });
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Aggregate computation
    // ──────────────────────────────────────────────────────────────────────────

    private recomputeAggregates(symbol: string): void {
        const entries = this.cache.get(symbol);
        if (!entries || entries.length === 0) {
            this.aggregates.delete(symbol);
            return;
        }

        const buyEntries = entries.filter(e => e.direction === 'buy');
        const sellEntries = entries.filter(e => e.direction === 'sell');
        const combinedCount = entries.length;

        const computeDirectional = (dirEntries: CachedSimulationEntry[]): DirectionalAggregates | undefined => {
            if (dirEntries.length === 0) return undefined;

            const mfe = this.safeAvg(dirEntries.map(e => e.mfe ?? 0));
            const mae = -this.safeAvg(dirEntries.map(e => Math.abs(e.mae ?? 0)));
            const ratio = mfe / (Math.abs(mae) || 1);

            const outcomeCounts = { tp: 0, partial_tp: 0, sl: 0, timeout: 0 };
            dirEntries.forEach(e => {
                if (e.outcome && e.outcome in outcomeCounts) {
                    outcomeCounts[e.outcome as keyof typeof outcomeCounts]++;
                }
            });

            const wins = outcomeCounts.tp + outcomeCounts.partial_tp;
            const winRate = dirEntries.length > 0 ? wins / dirEntries.length : 0;

            return {
                sampleCount: dirEntries.length,
                mfe,
                mae,
                excursionRatio: ratio,
                avgDurationMs: this.safeAvg(dirEntries.map(e => e.durationMs ?? 0)),
                outcomeCounts,
                winRate,
            };
        };

        const buyAgg = computeDirectional(buyEntries);
        const sellAgg = computeDirectional(sellEntries);

        // Directional SL streaks
        let slStreakBuy = 0;
        for (const e of buyEntries) { if (e.outcome === 'sl') slStreakBuy++; else break; }
        let slStreakSell = 0;
        for (const e of sellEntries) { if (e.outcome === 'sl') slStreakSell++; else break; }
        let slStreakCombined = 0;
        for (const e of entries) { if (e.outcome === 'sl') slStreakCombined++; else break; }

        const totalTimeouts = (buyAgg?.outcomeCounts.timeout ?? 0) + (sellAgg?.outcomeCounts.timeout ?? 0);
        const timeoutRatio = combinedCount > 0 ? totalTimeouts / combinedCount : 0;

        // historyJson: expose all cached entries (up to maxClosedSims), not just 5
        const freshRegime: ExcursionRegime = {
            symbol,
            historyJson: entries.map(e => ({ ...e }) as SimulationHistoryEntry),
            recentSampleCount: combinedCount,
            slStreak: slStreakCombined,
            timeoutRatio,
            buy: buyAgg,
            sell: sellAgg,
            slStreakBuy,
            slStreakSell,
            activeCount: 0,
            updatedAt: new Date(),
        };

        this.aggregates.set(symbol, freshRegime);

        logger.debug('Aggregates recomputed', {
            symbol, totalSamples: combinedCount,
            buySamples: buyAgg?.sampleCount ?? 0,
            sellSamples: sellAgg?.sampleCount ?? 0,
            buyMfeMae: buyAgg ? `${buyAgg.mfe.toFixed(3)} / ${buyAgg.mae.toFixed(3)}` : 'n/a',
            sellMfeMae: sellAgg ? `${sellAgg.mfe.toFixed(3)} / ${sellAgg.mae.toFixed(3)}` : 'n/a',
            slStreakBuy, slStreakSell, slStreakCombined,
            timeoutRatio: timeoutRatio.toFixed(3),
        });
    }

    private safeAvg(values: number[], defaultValue = 0): number {
        if (!values || values.length === 0) return defaultValue;
        return values.reduce((acc, v) => acc + (v ?? 0), 0) / values.length;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Pruning
    // ──────────────────────────────────────────────────────────────────────────

    private _pruneEntries(entries: CachedSimulationEntry[], now: number): void {
        if (!entries || entries.length === 0) return;

        const cutoff = now - this.staleWindowMs;
        let removedByTime = 0;

        for (let i = entries.length - 1; i >= 0; i--) {
            const entry = entries[i];
            if (typeof entry.timestamp !== 'number' || entry.timestamp <= 0) {
                logger.warn('_pruneEntries: invalid timestamp – removing', { signalId: entry.signalId ?? 'unknown' });
                entries.splice(i, 1);
                removedByTime++;
                continue;
            }
            if (entry.timestamp < cutoff) {
                entries.splice(i, 1);
                removedByTime++;
            }
        }

        let removedByLimit = 0;
        if (entries.length > this.maxClosedSims) {
            removedByLimit = entries.length - this.maxClosedSims;
            entries.length = this.maxClosedSims;
        }

        if (removedByTime > 0 || removedByLimit > 0) {
            logger.info('Prune completed', {
                removedByTime, removedByLimit,
                finalCount: entries.length,
                buyCount: entries.filter(e => e.direction === 'buy').length,
                sellCount: entries.filter(e => e.direction === 'sell').length,
            });
        }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Read path
    // ──────────────────────────────────────────────────────────────────────────

    public getRegime(symbol: string): ExcursionRegime | null {
        const normalized = symbol.trim().toUpperCase();
        if (!normalized) { logger.warn('getRegime: empty symbol'); return null; }

        let regime = this.aggregates.get(normalized);
        if (regime) return regime;

        const entries = this.cache.get(normalized);
        if (!entries || entries.length === 0) {
            this.aggregates.delete(normalized);
            return null;
        }

        this.recomputeAggregates(normalized);
        regime = this.aggregates.get(normalized);

        if (!regime) {
            logger.error('getRegime: recompute ran but no regime stored', { symbol: normalized });
            return null;
        }

        return regime;
    }

    public getRegimeLite(symbol: string): ExcursionRegimeLite | null {
        const full = this.getRegime(symbol);
        if (!full) return null;
        const { historyJson, ...lite } = full;
        return lite as ExcursionRegimeLite;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Warmup from DB
    // ──────────────────────────────────────────────────────────────────────────

    public async warmUpFromDb(recencyHours: number = STALE_WINDOW_HOURS): Promise<void> {
        const cutoffTime = Date.now() - recencyHours * 60 * 60 * 1000;

        try {
            logger.info('Starting cache warm-up from DB', { recencyHours });

            const recentSims = await dbService.getRecentLabeledSimulations(cutoffTime);

            if (recentSims.length === 0) {
                logger.info('No recent labeled simulations in DB – cache starts empty');
                return;
            }

            logger.info(`Warming up from ${recentSims.length} DB rows`);

            // Group by symbol, keep newest MAX_CLOSED_SIMS_PER_SYMBOL per symbol
            const bySymbol = new Map<string, SimulatedTrade[]>();
            for (const row of recentSims) {
                if (!bySymbol.has(row.symbol)) bySymbol.set(row.symbol, []);
                const arr = bySymbol.get(row.symbol)!;
                if (arr.length < MAX_CLOSED_SIMS_PER_SYMBOL) arr.push(row);
            }

            let totalLoaded = 0;
            for (const [symbol, sims] of bySymbol) {
                for (const sim of sims) {
                    // DB stores mfe/mae as boundedMfe * 1e8 (two ×1e4 layers — see file header)
                    const cacheEntry: CachedSimulationEntry = {
                        signalId: sim.signalId,
                        timestamp: sim.closedAt!,
                        direction: sim.side as Direction,
                        outcome: sim.outcome! as SimulationOutcome,
                        rMultiple: (sim.rMultiple ?? 0) / 10000,
                        label: sim.label! as SignalLabel,
                        mfe: (sim.maxFavorableExcursion ?? 0) / 1e8,
                        mae: (sim.maxAdverseExcursion ?? 0) / 1e8,
                        durationMs: sim.durationMs ?? 0,
                        timeToMFE_ms: sim.timeToMFEMs ?? 0,
                        timeToMAE_ms: sim.timeToMAEMs ?? 0,
                    };
                    this.addCompletedSimulation(symbol, cacheEntry);
                    totalLoaded++;
                }
            }

            logger.info('Cache warm-up complete', {
                symbolsLoaded: bySymbol.size,
                totalSimulationsLoaded: totalLoaded,
                recencyHours,
            });

        } catch (err) {
            logger.error('Cache warm-up failed – starting with empty cache', {
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Periodic cleanup
    // ──────────────────────────────────────────────────────────────────────────

    public cleanup(): void {
        if (this.cache.size === 0) return;

        const now = Date.now();
        let prunedTotal = 0;
        let symbolsDeleted = 0;

        for (const [symbol, entries] of this.cache.entries()) {
            const before = entries.length;
            this._pruneEntries(entries, now);
            const after = entries.length;

            if (after === 0) {
                this.cache.delete(symbol);
                this.aggregates.delete(symbol);
                symbolsDeleted++;
            } else if (after < before) {
                this.recomputeAggregates(symbol);
                prunedTotal += before - after;
            }
        }

        if (prunedTotal > 0 || symbolsDeleted > 0) {
            logger.info('Periodic cleanup done', {
                prunedEntries: prunedTotal,
                symbolsDeleted,
                remainingSymbols: this.cache.size,
            });
        }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Shutdown
    // ──────────────────────────────────────────────────────────────────────────

    public destroy(): void {
        if (!this.cleanupTimer) return;
        clearInterval(this.cleanupTimer);
        this.cleanupTimer = null;
        try { this.cleanup(); } catch (_) { /* best-effort */ }
        logger.info('ExcursionHistoryCache destroyed');
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Static utilities
    // ──────────────────────────────────────────────────────────────────────────

    /**
     * Determines whether a symbol has enough samples to trust directional stats.
     *
     * Three-tier response (instead of binary pass/fail):
     *   'full'    → sideCount >= MIN_SAMPLES_FULL_TRUST (3)   — full confidence
     *   'partial' → sideCount >= MIN_SAMPLES_HARD_SKIP  (1)   — use with discount
     *   'none'    → sideCount == 0                            — hard skip
     *
     * When direction is omitted, checks combined recentSampleCount (alert gate only).
     */
    public static getTrustLevel(
        regime: ExcursionRegime | ExcursionRegimeLite | null | undefined,
        direction?: LongShort
    ): 'full' | 'partial' | 'none' {
        if (!regime || typeof regime !== 'object') return 'none';

        if (!direction) {
            return regime.recentSampleCount >= MIN_SAMPLES_FULL_TRUST ? 'full'
                : regime.recentSampleCount >= MIN_SAMPLES_HARD_SKIP ? 'partial'
                    : 'none';
        }

        const sideCount = (direction === 'long' ? regime.buy : regime.sell)?.sampleCount ?? 0;

        return sideCount >= MIN_SAMPLES_FULL_TRUST ? 'full'
            : sideCount >= MIN_SAMPLES_HARD_SKIP ? 'partial'
                : 'none';
    }

    /**
     * Backward-compatible boolean wrapper around getTrustLevel.
     * Returns true for 'full' or 'partial', false for 'none'.
     */
    public static hasEnoughSamples(
        regime: ExcursionRegime | ExcursionRegimeLite | null | undefined,
        minSamples: number = MIN_SAMPLES_FULL_TRUST,
        direction?: LongShort
    ): boolean {
        if (!regime || typeof regime !== 'object') return false;

        const effectiveMin = Math.max(1, Math.floor(minSamples));

        if (!direction) {
            return (regime.recentSampleCount ?? 0) >= effectiveMin;
        }

        const sideCount = (direction === 'long' ? regime.buy : regime.sell)?.sampleCount ?? 0;
        return sideCount >= effectiveMin;
    }

    public static computeExcursionRatio(mfe: number, mae: number): number {
        if (mfe <= 0) return 0;
        const absMae = Math.abs(mae);
        if (absMae < 1e-6) return 0;
        return Math.max(0, Math.min(50, mfe / absMae));
    }

    public static normalizeExcursion(value: number, entryPrice: number): number {
        if (entryPrice <= 0 || isNaN(entryPrice) || !isFinite(entryPrice)) {
            if (process.env.NODE_ENV !== 'production') {
                throw new Error(`normalizeExcursion: invalid entryPrice ${entryPrice}`);
            }
            return 0;
        }
        if (value === 0 || isNaN(value) || !isFinite(value)) return 0;
        const pct = (value / entryPrice) * 100;
        return Math.max(-10000, Math.min(10000, pct));
    }

    public static isHighMaeRisk(
        regime: ExcursionRegime | ExcursionRegimeLite | null | undefined,
        direction: LongShort
    ): boolean {
        if (!regime || typeof regime !== 'object') return false;

        const maxMaePct = config.strategy?.maxMaePct ?? 3.0;
        const minSamples = config.strategy?.minExcursionSamples ?? MIN_SAMPLES_FULL_TRUST;

        if (!ExcursionHistoryCache.hasEnoughSamples(regime, minSamples, direction)) return false;

        const sideAgg = direction === 'long' ? regime.buy : regime.sell;
        const mae = sideAgg?.mae;
        if (mae === undefined || mae === 0) return false;

        return Math.abs(mae) > maxMaePct;
    }
}

// Singleton export
export const excursionCache = new ExcursionHistoryCache();
