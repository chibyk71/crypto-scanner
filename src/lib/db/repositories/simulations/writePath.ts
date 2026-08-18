// src/lib/db/repositories/simulations/writePath.ts
// Simulation write-path operations (create / update / mark taken)

import { eq } from 'drizzle-orm';
import type { MySql2Database } from 'drizzle-orm/mysql2';
import { simulatedTrades } from '../../schema';
import { createLogger } from '../../../logger';
import type { PartialTPLevel } from '../../../../types';
import type { MarketRegime } from '../../../strategy/regime/types';

const logger = createLogger('db:simulations:write');

type Db = MySql2Database<any>;

/**
 * Creates a new empty simulation row with the provided signalId.
 * Seeds default/starting values for a fresh simulation.
 * Used to reserve a row early (e.g. before async polling begins),
 * so we can reference it immediately via signalId.
 *
 * @param signalId Unique UUID of the signal (must be pre-generated)
 * @param symbol Trading pair (e.g. 'BTC/USDT')
 * @param side 'buy' or 'sell'
 * @param entryPrice Entry price (raw number, will be stored as-is)
 * @param openedAt Unix ms timestamp when simulation was started (defaults to now)
 * @param features Optional initial feature vector
 * @param confidence Confidence score from strategy (1 to 100)
 * @returns The created row (with defaults applied)
 */
export async function createNewSimulation(
    db: Db,
    signalId: string,
    symbol: string,
    side: 'buy' | 'sell',
    entryPrice: number,
    openedAt: number = Date.now(),
    features?: number[],
    confidence: number = 0,
    mlPredictedLabel?: number,
    mlPredictedConfidence?: number,
    regime?: MarketRegime,
): Promise<string> {
    try {
        const [inserted] = await db
            .insert(simulatedTrades)
            .values({
                signalId,
                symbol,
                side,
                regime: regime ?? null,
                entryPrice,               // stored as raw float
                openedAt,
                wasTaken: false,
                confidence,

                // Default/starting values
                pnl: 0,
                rMultiple: 0,
                maxFavorableExcursion: 0,
                maxAdverseExcursion: 0,
                durationMs: 0,
                timeToMFEMs: 0,
                timeToMAEMs: 0,

                // Nullable fields left undefined/null
                stopLoss: null,
                trailingDist: null,
                tpLevels: null,
                closedAt: null,
                outcome: null,
                label: null,

                // Optional features
                features: features && features.length > 0
                    ? features
                    : null,

                mlPredictedLabel: mlPredictedLabel ?? null,
                mlPredictedConfidence:
                    mlPredictedConfidence ?? null,
            })
            .$returningId();

        logger.debug('Created new empty simulation row', {
            signalId,
            symbol,
            side,
            regime,
            entryPrice,
            openedAt: new Date(openedAt).toISOString(),
        });

        return String(inserted.id);
    } catch (error) {
        logger.error('Failed to create new simulation row', {
            signalId,
            symbol,
            side,
            regime,
            entryPrice,
            error: error instanceof Error
                ? error.message
                : String(error),
        });

        throw error;
    }
}

/**
 * Updates an existing simulation row with the final outcome and metrics.
 *
 * This method is called at the end of a simulation (after polling/timeout)
 * to fill in the results into a row that was pre-created with signalId.
 *
 * It performs a targeted UPDATE instead of INSERT, ensuring we don't duplicate rows.
 * Only updates fields that are now known (outcome, pnl, excursions, etc.).
 * Leaves early fields (symbol, side, entryPrice, openedAt, wasTaken, etc.) unchanged.
 *
 * @param signalId The unique UUID of the simulation to update
 * @param data The final simulation results to apply
 * @returns true if the row was updated (affected rows > 0), false if no matching row found
 */
export async function updateCompletedSimulation(
    db: Db,
    signalId: string,
    data: {
        stoploss?: number;
        trailingDist?: number;
        tpLevels?: PartialTPLevel[];
        closedAt: number;                   // Unix ms
        outcome: 'tp' | 'partial_tp' | 'sl' | 'timeout';
        pnl: number;                        // decimal (e.g. 0.023 = +2.3%)
        rMultiple: number;
        label: -2 | -1 | 0 | 1 | 2;
        maxFavorableExcursion: number;      // positive % (e.g. 0.015 = 1.5%)
        maxAdverseExcursion: number;        // negative % (e.g. -0.008 = -0.8%)
        durationMs: number;
        timeToMFEMs: number;
        timeToMAEMs: number;
        features?: number[];                // optional – can overwrite if needed
        trailingTriggered?: boolean;         // did the counterfactual trailing stop fire during this sim?
        trailingExitPrice?: number;          // price it would have exited at, if triggered
        trailingExitPnl?: number;            // decimal PnL if exited via trailing (same scale as `pnl`)
        trailingExitAtMs?: number;           // ms from entry to the trailing exit point
    }
): Promise<boolean> {
    try {
        // Defensive guard: ensure openedAt ≤ closedAt (though openedAt is already set)
        if (data.closedAt <= 0) {
            throw new Error('Invalid closedAt timestamp');
        }

        const result = await db
            .update(simulatedTrades)
            .set({
                closedAt: data.closedAt,
                trailingDist: data.trailingDist,
                stopLoss: data.stoploss,
                tpLevels: data.tpLevels,
                outcome: data.outcome,
                pnl: Math.round(data.pnl * 1e8),                              // ×1e8
                rMultiple: Math.round(data.rMultiple * 1e4),                  // ×1e4
                label: data.label,
                maxFavorableExcursion: Math.round(data.maxFavorableExcursion * 1e4), // ×1e4
                maxAdverseExcursion: Math.round(data.maxAdverseExcursion * 1e4),     // ×1e4
                durationMs: data.durationMs,
                timeToMFEMs: data.timeToMFEMs,
                timeToMAEMs: data.timeToMAEMs,
                features: data.features !== undefined ? data.features : null, // overwrite only if provided
                trailingTriggered: data.trailingTriggered ?? false,
                trailingExitPrice: data.trailingExitPrice,
                trailingExitPnl: data.trailingExitPnl !== undefined
                    ? Math.round(data.trailingExitPnl * 1e8)                  // same ×1e8 scale as `pnl`
                    : undefined,
                trailingExitAtMs: data.trailingExitAtMs,
            })
            .where(eq(simulatedTrades.signalId, signalId))
            .execute();

        const affectedRows = result[0].affectedRows ?? 0;

        if (affectedRows === 0) {
            logger.warn('No simulation row found to update', { signalId });
            return false;
        }

        logger.info('Updated completed simulation', {
            signalId,
            outcome: data.outcome,
            label: data.label,
            rMultiple: data.rMultiple.toFixed(3),
            pnlPercent: (data.pnl * 100).toFixed(2) + '%',
            durationMin: (data.durationMs / 60000).toFixed(1),
            mfe: data.maxFavorableExcursion.toFixed(4) + '%',
            mae: data.maxAdverseExcursion.toFixed(4) + '%',
            affectedRows,
            trailingTriggered: data.trailingTriggered ?? false,
            trailingExitPnlPercent: data.trailingExitPnl !== undefined ? (data.trailingExitPnl * 100).toFixed(2) + '%'
                : 'n/a',
        });

        return true;
    } catch (error) {
        logger.error('Failed to update completed simulation', {
            signalId,
            outcome: data.outcome,
            error: error instanceof Error ? error.message : String(error),
        });
        throw error; // Let caller handle retry or fallback
    }
}

/**
 * Marks a specific simulation as "taken" (i.e., the trade was approved by excursion logic
 * and either executed live or would have been executed if auto-trade was enabled).
 *
 * This allows accurate performance tracking of only the filtered/traded signals,
 * separate from all raw simulations used for regime building and ML training.
 *
 * @param signalId - The unique UUID of the simulation row
 * @param taken - Whether to mark as taken (true) or untaken (false). Defaults to true.
 * @returns Promise<void> - Resolves when update is complete
 * @throws Error if update fails (logged internally)
 */
export async function setSimulationTaken(
    db: Db,
    signalId: string,
    taken: boolean = true,
    maxRetries: number = 5,
    retryDelayMs: number = 2000
): Promise<void> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const result = await db
                .update(simulatedTrades)
                .set({ wasTaken: taken })
                .where(eq(simulatedTrades.signalId, signalId))
                .execute();

            if (result[0].affectedRows > 0) {
                logger.debug(`Updated simulation was_taken status`, {
                    signalId, wasTaken: taken, attempt
                });
                return; // success
            }

            // Row doesn't exist yet — sim hasn't been created yet
            if (attempt < maxRetries) {
                logger.debug(`setSimulationTaken: row not found yet, retrying in ${retryDelayMs}ms`, {
                    signalId, attempt, maxRetries
                });
                await new Promise(resolve => setTimeout(resolve, retryDelayMs));
            } else {
                logger.warn(`setSimulationTaken: row never appeared after ${maxRetries} attempts`, {
                    signalId, taken
                });
            }
        } catch (error) {
            logger.error(`Failed to update was_taken for simulation`, {
                signalId, taken, attempt,
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }
}
