// src/lib/db/repositories/simulations/readPath.ts
// Simulation read-path operations (training samples, labeled, closed, recent)

import { and, desc, eq, gte, isNotNull, isNull, not } from 'drizzle-orm';
import type { MySql2Database } from 'drizzle-orm/mysql2';
import { simulatedTrades, type SimulatedTrade } from '../../schema';
import { createLogger } from '../../../logger';

const logger = createLogger('db:simulations:read');

type Db = MySql2Database<any>;

/**
 * Retrieves all simulated trades that have a computed label (i.e., ready for ML training),
 * ordered by closed time descending (most recent first).
 *
 * New reality (after removing training_samples table):
 *   - Single source of truth = simulatedTrades table
 *   - Training data = rows WHERE label IS NOT NULL
 *   - No duplication — features, label, mfe/mae, duration etc. live in one place
 *
 * Used by:
 *   • MLService.retrain() – to load full dataset for training
 *   • Debugging, analytics, or reporting commands
 *
 * Important notes:
 *   - Only closed simulations with label are returned
 *   - Features are stored as JSON → safely parsed to number[]
 *   - If features somehow stored as string (DB quirk), it's handled
 *   - Returns SimulatedTrade type (with all excursion/duration fields)
 *
 * @returns Array of SimulatedTrade objects with parsed features
 */
export async function getTrainingSamples(db: Db): Promise<SimulatedTrade[]> {
    // Query only labeled (completed + labeled) simulations, newest first
    const rows = await db
        .select()
        .from(simulatedTrades)
        .where(isNotNull(simulatedTrades.label))
        .orderBy(desc(simulatedTrades.closedAt))
        .execute();

    // Normalize features: ensure it's always number[] (handle DB string edge case)
    return rows.map(row => ({
        ...row,
        features: row.features
            ? (typeof row.features === 'string'
                ? JSON.parse(row.features)
                : Array.isArray(row.features)
                    ? row.features
                    : [])
            : [],  // fallback to empty array if missing/null
    }));
}

/**
 * Fetches the most recently closed simulated trades.
 *
 * Used for:
 *   • Debugging simulation outcomes
 *   • Performance analysis
 *   • Telegram commands showing recent results
 *
 * @param limit - Maximum number of trades to return (default 500)
 * @returns Array of closed SimulatedTrade objects, newest first
 */
export async function getClosedSimulatedTrades(db: Db, limit = 500): Promise<SimulatedTrade[]> {
    return await db
        .select()
        .from(simulatedTrades)
        .where(not(isNull(simulatedTrades.closedAt)))     // Only completed trades
        .orderBy(desc(simulatedTrades.closedAt))         // Most recent first
        .limit(limit)
        .execute();
}

/**
 * Fetches all simulations that have a computed label (i.e., ready for ML training).
 *
 * This is the primary method used by MLService.retrain() to load training data.
 *
 * Key features:
 *   - Filters WHERE label IS NOT NULL (only completed + labeled rows)
 *   - Orders by closedAt DESC (most recent first)
 *   - Safely parses features JSON → number[]
 *   - Optional: limit, symbol filter, offset for pagination/large datasets
 *   - Returns empty array on error (fail-safe for retrain)
 *
 * @param options Optional filters and limits
 * @returns Array of fully typed SimulatedTrade objects with parsed features
 */
export async function getLabeledSimulations(db: Db, options: {
    limit?: number;          // max rows to return (default: all)
    offset?: number;         // skip first N rows (for pagination)
    symbol?: string;         // filter to one symbol only
    side?: 'buy' | 'sell';   //
} = {}): Promise<SimulatedTrade[]> {
    const { limit, offset = 0, symbol, side } = options;

    try {
        const conditions = [isNotNull(simulatedTrades.label)];
        if (symbol) conditions.push(eq(simulatedTrades.symbol, symbol.trim().toUpperCase()));
        if (side) conditions.push(eq(simulatedTrades.side, side));

        let query = db
            .select()
            .from(simulatedTrades)
            .where(and(...conditions))
            .orderBy(desc(simulatedTrades.closedAt))
            .offset(offset)
            .$dynamic();

        if (limit !== undefined) {
            query = query.limit(limit);
        }

        const rows = await query.execute();

        // Safely parse features (handle string JSON from DB or already-parsed array)
        const parsedRows = rows.map(row => ({
            ...row,
            features: row.features
                ? (typeof row.features === 'string'
                    ? JSON.parse(row.features)
                    : Array.isArray(row.features)
                        ? row.features
                        : [])
                : [],  // fallback empty array if missing/null
        }));

        logger.debug('Fetched labeled simulations', {
            count: parsedRows.length,
            limit: limit ?? 'all',
            symbol: symbol ?? 'all',
            offset,
            sampleFeaturesLength: parsedRows[0]?.features?.length ?? 'none',
        });

        return parsedRows;

    } catch (err) {
        logger.error('Failed to fetch labeled simulations', {
            error: err instanceof Error ? err.message : String(err),
            symbol: options.symbol,
            limit: options.limit,
        });
        return []; // fail-safe: empty array so retrain can continue gracefully
    }
}

/**
 * Fetches recent labeled & closed simulations for cache warm-up on startup.
 *
 * This is the main DB query used by `excursionCache.warmUpFromDb()`.
 *
 * Filters:
 *   - label IS NOT NULL          → only simulations ready for ML/training
 *   - closedAt IS NOT NULL       → only completed simulations
 *   - closedAt >= cutoffTime     → respects recency window (default 3 hours)
 *
 * Returns newest first (DESC closedAt)
 * Safety limit: max 2000 rows (prevents loading millions of old rows on startup)
 */
export async function getRecentLabeledSimulations(db: Db, cutoffTime: number): Promise<SimulatedTrade[]> {
    try {
        const MAX_ROWS = 2000; // safety limit — prevents huge queries on first run

        const rows = await db
            .select()
            .from(simulatedTrades)
            .where(and(
                isNotNull(simulatedTrades.label),
                isNotNull(simulatedTrades.closedAt),
                gte(simulatedTrades.closedAt, cutoffTime)
            ))
            .orderBy(desc(simulatedTrades.closedAt))
            .limit(MAX_ROWS)
            .execute();

        // Safely parse features (DB may return string or already-parsed array)
        const parsed = rows.map(row => ({
            ...row,
            features: row.features
                ? (typeof row.features === 'string'
                    ? JSON.parse(row.features)
                    : Array.isArray(row.features)
                        ? row.features
                        : [])
                : [], // fallback: empty array
        }));

        logger.info(`Fetched recent labeled simulations for cache warm-up`, {
            count: parsed.length,
            cutoffTime: new Date(cutoffTime).toISOString(),
            maxRowsApplied: parsed.length === MAX_ROWS,
        });

        return parsed;

    } catch (err) {
        logger.error('Failed to fetch recent labeled simulations for warm-up', {
            cutoffTime: new Date(cutoffTime).toISOString(),
            error: err instanceof Error ? err.message : String(err),
        });

        // Fail-safe: return empty array so warm-up continues gracefully
        return [];
    }
}
