// src/lib/db/repositories/simulations/analytics.ts
// Simulation analytics & stats queries

import { and, count, desc, eq, gte, isNotNull, isNull, not, sql } from 'drizzle-orm';
import type { MySql2Database } from 'drizzle-orm/mysql2';

import { createLogger } from '../../../logger';
import { simulatedTrades } from '../../schema';

const logger = createLogger('db:simulations:analytics');

type Db = MySql2Database<any>;

/**
 * Fetches performance statistics only for simulations marked as taken.
 * Useful for evaluating how well the excursion filtering / regime logic performs
 * on trades that were actually approved.
 *
 * @param options Optional filters
 * @returns Object with key metrics
 */
export async function getTakenSimulationStats(db: Db, options: {
    symbol?: string;
    since?: number;           // Unix ms cutoff
    minRMultiple?: number;    // optional filter
} = {}): Promise<{
    totalTaken: number;
    wins: number;
    winRate: number;          // percentage
    avgPnL: number;
    avgRMultiple: number;
    totalPnL: number;
    outcomes: {
        tp: number;
        partial_tp: number;
        sl: number;
        timeout: number;
    };
}> {
    try {
        const conditions = [
            eq(simulatedTrades.wasTaken, true),
            isNotNull(simulatedTrades.closedAt),
            isNotNull(simulatedTrades.label),
        ];

        if (options.symbol) {
            conditions.push(eq(simulatedTrades.symbol, options.symbol));
        }
        if (options.since) {
            conditions.push(gte(simulatedTrades.closedAt, options.since));
        }

        const whereClause = and(...conditions);

        // Aggregate query
        const [stats] = await db
            .select({
                totalTaken: count().as('totalTaken'),
                wins: sql<number>`SUM(CASE WHEN ${simulatedTrades.outcome} IN ('tp', 'partial_tp') THEN 1 ELSE 0 END)`.mapWith(Number),
                totalPnL: sql<number>`SUM(${simulatedTrades.pnl} / 1e8)`.mapWith(Number),
                avgPnL: sql<number>`AVG(${simulatedTrades.pnl} / 1e8)`.mapWith(Number),
                avgRMultiple: sql<number>`AVG(${simulatedTrades.rMultiple} / 1e4)`.mapWith(Number),
                tp: sql<number>`SUM(CASE WHEN ${simulatedTrades.outcome} = 'tp' THEN 1 ELSE 0 END)`.mapWith(Number),
                partial_tp: sql<number>`SUM(CASE WHEN ${simulatedTrades.outcome} = 'partial_tp' THEN 1 ELSE 0 END)`.mapWith(Number),
                sl: sql<number>`SUM(CASE WHEN ${simulatedTrades.outcome} = 'sl' THEN 1 ELSE 0 END)`.mapWith(Number),
                timeout: sql<number>`SUM(CASE WHEN ${simulatedTrades.outcome} = 'timeout' THEN 1 ELSE 0 END)`.mapWith(Number),
            })
            .from(simulatedTrades)
            .where(whereClause)
            .execute();

        const total = stats.totalTaken || 0;
        const wins = stats.wins || 0;
        const winRate = total > 0 ? (wins / total) * 100 : 0;

        return {
            totalTaken: total,
            wins,
            winRate,
            avgPnL: stats.avgPnL || 0,
            avgRMultiple: stats.avgRMultiple || 0,
            totalPnL: stats.totalPnL || 0,
            outcomes: {
                tp: stats.tp || 0,
                partial_tp: stats.partial_tp || 0,
                sl: stats.sl || 0,
                timeout: stats.timeout || 0,
            },
        };
    } catch (err) {
        logger.error('Failed to fetch taken simulation stats', { error: err });
        return {
            totalTaken: 0,
            wins: 0,
            winRate: 0,
            avgPnL: 0,
            avgRMultiple: 0,
            totalPnL: 0,
            outcomes: { tp: 0, partial_tp: 0, sl: 0, timeout: 0 },
        };
    }
}


/**
 * Fetches all labeled simulations formatted for CSV export.
 * Called by TelegramBotController /export_training_data command.
 *
 * Returns only the columns Python needs:
 *   • features  — JSON array string (parsed by ml/utils.py)
 *   • label     — integer -2..+2
 *   • symbol    — for debugging/filtering in Python
 *   • side      — 'buy' | 'sell' (useful for per-side analysis)
 *   • outcome   — 'tp' | 'sl' | 'timeout' etc
 *   • closed_at — timestamp (useful for time-based filtering)
 *
 * Deliberately excludes heavy columns (pnl raw bytes, tpLevels JSON etc)
 * to keep the CSV file small and fast to send via Telegram.
 */
export async function getExportableSimulations(db: Db, side?: 'buy' | 'sell'): Promise<Array<{
    symbol: string;
    side: string;
    label: number;
    outcome: string | null;
    closedAt: number | null;
    features: string;  // JSON string — Python parses this
}>> {
    try {
        const conditions = [
            isNotNull(simulatedTrades.label),
            isNotNull(simulatedTrades.features),
            isNotNull(simulatedTrades.closedAt),
        ];
        if (side) conditions.push(eq(simulatedTrades.side, side));

        const rows = await db
            .select({
                symbol: simulatedTrades.symbol,
                side: simulatedTrades.side,
                label: simulatedTrades.label,
                outcome: simulatedTrades.outcome,
                closedAt: simulatedTrades.closedAt,
                features: simulatedTrades.features,
            })
            .from(simulatedTrades)
            .where(and(...conditions))
            .orderBy(desc(simulatedTrades.closedAt))
            .execute();

        // Serialize features to JSON string so CSV stays flat
        // Python's pandas reads this as a string then json.loads() each cell
        return rows.map(row => ({
            symbol: row.symbol,
            side: row.side,
            label: row.label!,
            outcome: row.outcome,
            closedAt: row.closedAt,
            // features may already be an object if Drizzle parsed it —
            // always stringify so the CSV cell is a clean JSON string
            features: typeof row.features === 'string'
                ? row.features
                : JSON.stringify(row.features),
        }));

    } catch (err) {
        logger.error('Failed to fetch exportable simulations', {
            error: err instanceof Error ? err.message : String(err),
        });
        return [];
    }
}

/**
 * Retrieves a quick comparison between:
 * - Total number of closed (completed) simulations
 * - Number of simulations marked as taken (was_taken = true)
 * - The percentage of simulations that passed the excursion/regime filter
 *
 * Used primarily by the Telegram bot command /takenvsall to show
 * how selective the current filtering logic is.
 *
 * @returns Promise with counts and calculated percentage
 */
export async function getTakenVsTotalCount(db: Db): Promise<{
    totalSims: number;
    takenSims: number;
    takenPercentage: number;
}> {
    try {
        // ── 1. Count all closed simulations ─────────────────────────────────────
        const [totalResult] = await db
            .select({
                count: count().as('total'),
            })
            .from(simulatedTrades)
            .where(and(
                isNotNull(simulatedTrades.closedAt),
                // Optional: only count simulations that have an outcome/label
                // (remove if you want to include pending/incomplete ones)
                isNotNull(simulatedTrades.outcome)
            ))
            .execute();

        const totalSims = Number(totalResult?.count ?? 0);

        // ── 2. Count only taken (filtered/executed) simulations ─────────────────
        const [takenResult] = await db
            .select({
                count: count(),
            })
            .from(simulatedTrades)
            .where(and(
                eq(simulatedTrades.wasTaken, true),
                isNotNull(simulatedTrades.closedAt),
                isNotNull(simulatedTrades.outcome)
            ))
            .execute();

        const takenSims = Number(takenResult?.count ?? 0);

        // ── 3. Calculate percentage (safe handling for division by zero) ────────
        const takenPercentage = totalSims > 0
            ? (takenSims / totalSims) * 100
            : 0;

        return {
            totalSims,
            takenSims,
            takenPercentage,
        };
    } catch (error) {
        logger.error('Failed to compute taken vs total simulation counts', {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
        });

        // Graceful fallback — better to return zeros than crash the command
        return {
            totalSims: 0,
            takenSims: 0,
            takenPercentage: 0,
        };
    }
}

/**
 * Retrieves performance statistics for taken simulations, grouped by symbol.
 * Only includes completed simulations where `was_taken = true`.
 *
 * Results are sorted by total taken trades (descending) and limited to the requested count.
 *
 * @param limit Maximum number of symbols to return (default: 20)
 * @param since Optional Unix timestamp (ms) — only include simulations closed after this time
 * @returns Array of symbol stats, sorted by totalTaken descending
 */
export async function getTakenStatsBySymbol(
    db: Db,
    limit: number = 20,
    since?: number
): Promise<Array<{
    symbol: string;
    totalTaken: number;
    winRate: number;     // percentage (0–100)
    avgR: number;        // average R-multiple
    totalPnL: number;    // cumulative realized PnL
}>> {
    // Enforce reasonable limit range to prevent abuse or performance issues
    const safeLimit = Math.max(1, Math.min(50, limit));

    try {
        const conditions = [
            eq(simulatedTrades.wasTaken, true),
            isNotNull(simulatedTrades.closedAt),
            // Only count simulations with a meaningful outcome
            isNotNull(simulatedTrades.outcome),
        ];

        if (since !== undefined) {
            conditions.push(gte(simulatedTrades.closedAt, since));
        }

        const whereClause = and(...conditions);

        const rows = await db
            .select({
                symbol: simulatedTrades.symbol,
                totalTaken: count().as('totalTaken'),
                wins: sql<number>`SUM(CASE WHEN ${simulatedTrades.outcome} IN ('tp', 'partial_tp') THEN 1 ELSE 0 END)`.mapWith(Number),
                totalPnL: sql<number>`COALESCE(SUM(${simulatedTrades.pnl} / 1e8), 0)`.mapWith(Number),
                avgR: sql<number>`COALESCE(AVG(${simulatedTrades.rMultiple} / 1e4), 0)`.mapWith(Number),
            })
            .from(simulatedTrades)
            .where(whereClause)
            .groupBy(simulatedTrades.symbol)
            .orderBy(desc(sql`totalTaken`))
            .limit(safeLimit)
            .execute();

        // Transform raw DB rows into clean result objects
        return rows.map(row => {
            const total = Number(row.totalTaken) || 0;
            const wins = Number(row.wins) || 0;

            return {
                symbol: row.symbol,
                totalTaken: total,
                winRate: total > 0 ? (wins / total) * 100 : 0,
                avgR: Number(row.avgR) || 0,
                totalPnL: Number(row.totalPnL) || 0,
            };
        });
    } catch (error) {
        logger.error('Failed to fetch taken stats by symbol', {
            limit: safeLimit,
            since: since ? new Date(since).toISOString() : undefined,
            error: error instanceof Error ? error.message : String(error),
        });

        // Return empty array on failure — safe fallback for UI/Telegram
        return [];
    }
}

/**
 * Returns the count of labeled simulations for each possible label (-2 to +2).
 *
 * Returns a complete distribution (all labels present, even if count = 0).
 * Used for:
 *   • MLService status reporting (/ml_status)
 *   • Monitoring class balance (critical for model health)
 *   • Telegram /ml_performance command
 *
 * @returns Array of { label: number; count: number } with all labels -2 to +2
 */
export async function getLabelDistribution(db: Db): Promise<{ label: number; count: number }[]> {
    try {
        // Raw count per existing label
        const result = await db
            .select({
                label: simulatedTrades.label,
                count: count().as('count'),
            })
            .from(simulatedTrades)
            .where(isNotNull(simulatedTrades.label))
            .groupBy(simulatedTrades.label)
            .orderBy(simulatedTrades.label)
            .execute();

        // Initialize full distribution map with 0s for all labels
        const distributionMap = new Map<number, number>();
        for (let label = -2; label <= 2; label++) {
            distributionMap.set(label, 0);
        }

        // Fill in actual counts
        for (const row of result) {
            if (row.label !== null) {
                distributionMap.set(row.label, Number(row.count));
            }
        }

        // Convert to sorted array
        return Array.from(distributionMap.entries())
            .map(([label, count]) => ({ label, count }))
            .sort((a, b) => a.label - b.label);

    } catch (err) {
        logger.error('Failed to compute label distribution', {
            error: err instanceof Error ? err.message : String(err),
        });

        // Fail-safe: return empty distribution with zeros
        return [
            { label: -2, count: 0 },
            { label: -1, count: 0 },
            { label: 0, count: 0 },
            { label: 1, count: 0 },
            { label: 2, count: 0 },
        ];
    }
}

/**
 * Returns the total number of labeled simulations ready for ML training.
 *
 * Counts rows in simulatedTrades where label IS NOT NULL.
 * Used by:
 *   • MLService.retrain() – to check if enough samples exist
 *   • MLService.getStatus() – for Telegram status reporting
 *   • Monitoring / debugging (e.g. "are we collecting enough data?")
 *
 * @returns Number of simulations with a valid label (-2 to +2)
 */
export async function getSampleCount(db: Db, side?: 'buy' | 'sell'): Promise<number> {
    try {
        const conditions = [isNotNull(simulatedTrades.label)];
        if (side) conditions.push(eq(simulatedTrades.side, side));

        const result = await db
            .select({ count: count() })
            .from(simulatedTrades)
            .where(and(...conditions))
            .execute();

        const num = result[0]?.count ?? 0;
        logger.debug('Fetched labeled sample count', { num, side: side ?? 'all' });
        return num;
    } catch (err) {
        logger.error('Failed to get sample count', {
            error: err instanceof Error ? err.message : String(err),
            side,
        });
        return 0; // fail-safe: return 0 so retrain can gracefully skip
    }
}

/**
 * Aggregated summary of labeled simulations per symbol.
 *
 * Used by MLService.getSampleSummary() for Telegram reporting.
 *
 * Returns:
 *   - total: number of labeled sims
 *   - buys/sells: count by side
 *   - wins: count where label >= 1
 */
export async function getSimulationSummaryBySymbol(db: Db): Promise<Array<{
    symbol: string;
    total: number;
    buys: number;
    sells: number;
    wins: number;
}>> {
    try {
        const rows = await db
            .select({
                symbol: simulatedTrades.symbol,
                total: count(),
                buys: sql<number>`SUM(CASE WHEN side = 'buy' THEN 1 ELSE 0 END)`,
                sells: sql<number>`SUM(CASE WHEN side = 'sell' THEN 1 ELSE 0 END)`,
                wins: sql<number>`SUM(CASE WHEN label >= 1 THEN 1 ELSE 0 END)`,
            })
            .from(simulatedTrades)
            .where(isNotNull(simulatedTrades.label))
            .groupBy(simulatedTrades.symbol)
            .orderBy(desc(sql`total`)) // optional: most active symbols first
            .execute();

        logger.debug('Fetched simulation summary by symbol', { rowCount: rows.length });

        return rows;
    } catch (err) {
        logger.error('Failed to get simulation summary by symbol', {
            error: err instanceof Error ? err.message : String(err),
        });
        return [];
    }
}

/**
 * Retrieves the best-performing symbols based on simulation results.
 *
 * Used for:
 *   • Identifying which symbols the strategy works best on
 *   • Monitoring and reporting (e.g., Telegram commands or dashboard)
 *   • Potential future symbol filtering or weighting
 *
 * Filters:
 *   • Only closed simulations
 *   • Only profitable outcomes (label >= 1)
 *
 * Returns:
 *   • symbol
 *   • trades: total number of winning simulations
 *   • avgR: average R-multiple (higher = better risk-adjusted return)
 *   • strongWins: number of "monster wins" (label = 2)
 *
 * Sorted by avgR descending, limited to top N (default 20)
 *
 * @param limit - Maximum number of symbols to return (default 20)
 * @returns Array of top performing symbols
 */
export async function getTopPerformingSymbols(db: Db, limit = 20) {
    return await db
        .select({
            symbol: simulatedTrades.symbol,
            trades: count(),  // Total winning trades per symbol
            avgR: sql<number>`ROUND(AVG(${simulatedTrades.rMultiple} / 1e4), 3)`.mapWith(Number), // Convert ×1e4 back to actual R
            strongWins: sql<number>`SUM(CASE WHEN ${simulatedTrades.label} = 2 THEN 1 ELSE 0 END)`.mapWith(Number) // Count of label +2
        })
        .from(simulatedTrades)
        .where(and(
            not(isNull(simulatedTrades.closedAt)),     // Only completed simulations
            gte(simulatedTrades.label, 1)              // Only profitable ones (label 1 or 2)
        ))
        .groupBy(simulatedTrades.symbol)
        .orderBy(sql`avgR DESC`)                        // Best average R first
        .limit(limit)
        .execute();
}
