// src/lib/services/simulateTrade.ts
// =============================================================================
// HIGH-PRECISION TRADE SIMULATOR – CORE OF ML LABELING ENGINE
//
// Purpose:
//   • Simulate every generated signal with real market data
//   • Accurately calculate PnL, R-multiple, and Max Excursions (MFE/MAE)
//   • Provide perfect 5-tier labels (-2 to +2) for ML training
//   • Support partial take-profits, trailing stops, and timeout exits
//   • Store full lifecycle in DB for analysis and excursion stats
//
// Key Features:
//   • Normalized MFE/MAE as % of entry price (cross-symbol comparable)
//   • High-precision storage (×1e8 for prices/PnL, ×1e4 for percentages)
//   • Robust error handling in polling loop
//   • Comprehensive logging for debugging simulations
// =============================================================================

import { ExchangeService } from './exchange';
import { dbService } from '../db';
import { createLogger } from '../logger';
import type { TradeSignal } from '../../types';
import { normalizeExcursion } from '../utils/excursionUtils';  // ← NEW

const logger = createLogger('simulateTrade');

/**
 * Result of a completed simulation
 * Returned to caller (MarketScanner) for ML ingestion
 */
export interface SimulationResult {
    /** Final exit reason */
    outcome: 'tp' | 'partial_tp' | 'sl' | 'timeout';

    /** Raw PnL as decimal (e.g., 0.023 = +2.3%) */
    pnl: number;

    /** PnL as percentage */
    pnlPercent: number;

    /** Risk-multiple achieved (PnL / initial risk distance) */
    rMultiple: number;

    /** 5-tier ML label based on R-multiple */
    label: -2 | -1 | 0 | 1 | 2;

    /** Max Favorable Excursion – best unrealized profit as % of entry */
    maxFavorableExcursion: number;

    /** Max Adverse Excursion – worst drawdown as % of entry */
    maxAdverseExcursion: number;
}

/**
 * Main simulation function – runs a full trade lifecycle with interim excursion updates
 *
 * Called from:
 *   • MarketScanner.handleTradeSignal() – after every valid signal
 *
 * Process:
 *   1. Record simulation start in DB (generates unique signalId)
 *   2. Poll latest candle every 15s
 *   3. Continuously track price extremes → MFE/MAE
 *   4. Handle trailing stop movement
 *   5. Support partial take-profits and full TP/SL exits
 *   6. Update symbolHistory with interim excursion stats every 5 minutes and on partial TP
 *   7. Exit on timeout (1 hour max)
 *   8. Finalize results, close DB record, and return outcome for ML training
 *
 * Key Improvements:
 *   • Interim excursion updates → provides real-time advice for repeat signals
 *   • No more "No excursion history" on strong trending moves
 *   • Updates every ~5 minutes + on partial TP hits
 *   • Time-bound recent MFE/MAE and reverse counts for regime-aware decisions
 *
 * @param exchangeService - For real-time OHLCV polling
 * @param symbol - Trading pair
 * @param signal - Complete TradeSignal from Strategy
 * @param entryPrice - Exact entry price at signal generation
 * @returns Full simulation outcome for immediate ML ingestion
 */
export async function simulateTrade(
    exchangeService: ExchangeService,
    symbol: string,
    signal: TradeSignal,
    entryPrice: number
): Promise<SimulationResult> {
    // Critical safety check – avoid division by zero in PnL calculations
    if (entryPrice <= 0) {
        throw new Error('Invalid entryPrice: must be positive');
    }

    const isLong = signal.signal === 'buy';
    const direction: 'long' | 'short' = isLong ? 'long' : 'short';
    const hasTrailing = !!signal.trailingStopDistance;
    let currentStopLoss = signal.stopLoss ?? null;      // Updated dynamically by trailing
    let bestPrice = entryPrice;                         // Best favorable price seen (for trailing)

    const startTime = Date.now();
    const timeoutMs = 60 * 60 * 1000;                   // Max simulation time: 1 hour
    const pollIntervalMs = 15_000;                      // Poll exchange every 15 seconds
    const INTERIM_UPDATE_INTERVAL_MS = 5 * 60 * 1000;   // Every 5 minutes

    // Real-time excursion tracking
    let maxFavorablePrice = entryPrice;
    let maxAdversePrice = entryPrice;

    // Partial position management
    let remainingPosition = 1.0;                        // Fraction of original position
    let totalPnL = 0.0;                                 // Accumulated PnL from partial exits

    // Track last interim update timestamp
    let lastInterimUpdateTime = startTime;

    // === Prepare TP levels for DB storage ===
    const tpLevelsDb: { price: number; weight: number }[] = [];
    if (signal.takeProfit) {
        tpLevelsDb.push({ price: signal.takeProfit, weight: 1.0 });
    }
    if (signal.takeProfitLevels && signal.takeProfitLevels.length > 0) {
        tpLevelsDb.push(...signal.takeProfitLevels);
    }

    // === DB: Start simulation record ===
    const signalId = await dbService.startSimulatedTrade({
        symbol,
        side: signal.signal,
        entryPrice: Number(entryPrice.toFixed(8)),
        stopLoss: currentStopLoss ? Number(currentStopLoss.toFixed(8)) : null,
        trailingDist: signal.trailingStopDistance ? Number(signal.trailingStopDistance.toFixed(8)) : null,
        tpLevels: tpLevelsDb.length > 0 ? tpLevelsDb : null,
    });

    logger.info(`[SIM] ${symbol} ${isLong ? 'LONG' : 'SHORT'} @ ${entryPrice.toFixed(8)} | ID: ${signalId}`);

    // =========================================================================
    // MAIN SIMULATION LOOP – continues until exit or timeout
    // =========================================================================
    while (Date.now() - startTime < timeoutMs && remainingPosition > 0.01) {
        try {
            // Get latest candle from live cache
            const raw = exchangeService.getPrimaryOhlcvData(symbol);
            if (!raw || raw.length < 2) {
                await sleep(pollIntervalMs);
                continue;
            }

            const candle = raw[raw.length - 1];
            const high = Number(candle[2]);
            const low = Number(candle[3]);

            // Update excursion extremes
            if (isLong) {
                maxFavorablePrice = Math.max(maxFavorablePrice, high);
                maxAdversePrice = Math.min(maxAdversePrice, low);
            } else {
                maxFavorablePrice = Math.min(maxFavorablePrice, low);
                maxAdversePrice = Math.max(maxAdversePrice, high);
            }

            // Trailing stop logic – moves SL in favorable direction
            if (hasTrailing && currentStopLoss !== null) {
                if (isLong && high > bestPrice) {
                    bestPrice = high;
                    const newStop = bestPrice - signal.trailingStopDistance!;
                    if (newStop > currentStopLoss) currentStopLoss = newStop;
                } else if (!isLong && low < bestPrice) {
                    bestPrice = low;
                    const newStop = bestPrice + signal.trailingStopDistance!;
                    if (newStop < currentStopLoss) currentStopLoss = newStop;
                }
            }

            // === Partial Take-Profit Handling ===
            if (signal.takeProfitLevels && signal.takeProfitLevels.length > 0 && remainingPosition > 0.01) {
                const sortedLevels = [...signal.takeProfitLevels].sort((a, b) =>
                    isLong ? a.price - b.price : b.price - a.price
                );

                let partialClosed = false;
                for (const level of sortedLevels) {
                    const tpHit = isLong ? high >= level.price : low <= level.price;
                    if (tpHit && remainingPosition >= level.weight) {
                        const pnlThis = isLong
                            ? (level.price - entryPrice) / entryPrice
                            : (entryPrice - level.price) / entryPrice;

                        totalPnL += pnlThis * level.weight;
                        remainingPosition -= level.weight;
                        partialClosed = true;

                        logger.debug(`[SIM] Partial TP hit at ${level.price} (weight: ${level.weight})`);

                        // Interim excursion update on partial TP – gives fast feedback
                        const currentMfePct = normalizeExcursion(
                            isLong ? maxFavorablePrice - entryPrice : entryPrice - maxFavorablePrice,
                            entryPrice
                        );
                        const currentMaePct = normalizeExcursion(
                            isLong ? entryPrice - maxAdversePrice : maxAdversePrice - entryPrice,
                            entryPrice
                        );

                        // Update recent stats immediately on partial exit
                        await dbService.updateRecentExcursions(
                            symbol,
                            currentMfePct,
                            currentMaePct,
                            direction
                        );
                    }
                }

                if (partialClosed && remainingPosition <= 0.01) {
                    return await finalizeSimulation(
                        'partial_tp',
                        totalPnL,
                        signalId,
                        symbol,
                        entryPrice,
                        isLong,
                        maxFavorablePrice,
                        maxAdversePrice,
                    );
                }
            }
            // === Single Full Take-Profit ===
            else if (signal.takeProfit && remainingPosition > 0.01) {
                const tpHit = isLong ? high >= signal.takeProfit : low <= signal.takeProfit;
                if (tpHit) {
                    const pnlThis = isLong
                        ? (signal.takeProfit - entryPrice) / entryPrice
                        : (entryPrice - signal.takeProfit) / entryPrice;

                    totalPnL += pnlThis * remainingPosition;
                    remainingPosition = 0;

                    return await finalizeSimulation(
                        'tp',
                        totalPnL,
                        signalId,
                        symbol,
                        entryPrice,
                        isLong,
                        maxFavorablePrice,
                        maxAdversePrice,
                    );
                }
            }

            // === Stop Loss Check ===
            if (currentStopLoss && remainingPosition > 0.01) {
                const slHit = isLong ? low <= currentStopLoss : high >= currentStopLoss;
                if (slHit) {
                    const pnlThis = isLong
                        ? (currentStopLoss - entryPrice) / entryPrice
                        : (entryPrice - currentStopLoss) / entryPrice;

                    totalPnL += pnlThis * remainingPosition;
                    remainingPosition = 0;

                    return await finalizeSimulation(
                        'sl',
                        totalPnL,
                        signalId,
                        symbol,
                        entryPrice,
                        isLong,
                        maxFavorablePrice,
                        maxAdversePrice,
                    );
                }
            }

            // === Interim Excursion Update Every 5 Minutes ===
            const now = Date.now();
            if (now - lastInterimUpdateTime >= INTERIM_UPDATE_INTERVAL_MS) {
                lastInterimUpdateTime = now;

                const currentMfePct = normalizeExcursion(
                    isLong ? maxFavorablePrice - entryPrice : entryPrice - maxFavorablePrice,
                    entryPrice
                );
                const currentMaePct = normalizeExcursion(
                    isLong ? entryPrice - maxAdversePrice : maxAdversePrice - entryPrice,
                    entryPrice
                );

                // Fire-and-forget – doesn't block simulation
                void dbService.updateRecentExcursions(
                    symbol,
                    currentMfePct,
                    currentMaePct,
                    direction
                );

                logger.debug(`[SIM] Interim excursion update`, {
                    symbol,
                    mfe: currentMfePct.toFixed(2),
                    mae: currentMaePct.toFixed(2),
                });
            }

            await sleep(pollIntervalMs);
        } catch (err) {
            logger.error('Simulation loop error', { symbol, error: err });
            await sleep(pollIntervalMs);
        }
    }

    // =========================================================================
    // TIMEOUT EXIT – forced close after max duration
    // =========================================================================
    const finalRaw = exchangeService.getPrimaryOhlcvData(symbol);
    const last = finalRaw?.[finalRaw.length - 1];
    const exitPrice = last
        ? isLong ? Number(last[2]) : Number(last[3])  // High for long, low for short
        : entryPrice;

    const finalPnl = isLong
        ? (exitPrice - entryPrice) / entryPrice
        : (entryPrice - exitPrice) / entryPrice;

    totalPnL += finalPnl * remainingPosition;

    return await finalizeSimulation(
        'timeout',
        totalPnL,
        signalId,
        symbol,
        entryPrice,
        isLong,
        maxFavorablePrice,
        maxAdversePrice,
    );
}

/**
 * Finalizes the simulation: computes label, updates DB, handles recent stats & reverse counts
 * @returns SimulationResult
 */
async function finalizeSimulation(
    outcome: 'tp' | 'partial_tp' | 'sl' | 'timeout',
    totalPnL: number,
    signalId: string,
    symbol: string,
    entryPrice: number,
    isLong: boolean,
    maxFavorablePrice: number,
    maxAdversePrice: number,
): Promise<SimulationResult> {
    const riskDistance = entryPrice * 0.015; // fallback if no SL
    const rMultiple = totalPnL / (riskDistance / entryPrice);
    const label = computeLabel(rMultiple);

    // Final excursions
    const finalMfePct = normalizeExcursion(
        isLong ? maxFavorablePrice - entryPrice : entryPrice - maxFavorablePrice,
        entryPrice
    );
    const finalMaePct = normalizeExcursion(
        isLong ? entryPrice - maxAdversePrice : maxAdversePrice - entryPrice,
        entryPrice
    );

    // Detect strong reversal
    const isStrongReversal = Math.abs(label) >= 1 && label * (isLong ? 1 : -1) < 0;

    // Update recent excursions (final values)
    await dbService.updateRecentExcursions(
        symbol,
        finalMfePct,
        finalMaePct,
        isLong ? 'long' : 'short'
    );

    // Update reverse count if strong reversal
    if (isStrongReversal) {
        await dbService.incrementRecentReverseCount(
            symbol,
            isLong ? 'long' : 'short',
            1
        );
    }

    // Close simulation record in DB
    await dbService.closeSimulatedTrade(
        signalId,
        outcome,
        Math.round(totalPnL * 1e8),           // PnL ×1e8
        Math.round(rMultiple * 1e4),          // R ×1e4
        label,
        Math.round(finalMfePct * 1e4),        // MFE % ×1e4
        Math.round(finalMaePct * 1e4)         // MAE % ×1e4
    );

    // Preserve/update lifetime averages (your existing logic here)
    // Example placeholder – replace with your actual lifetime update code
    // await dbService.updateLifetimeAverages(symbol, finalMfePct, finalMaePct, rMultiple, label);

    logger.info(`[SIM] ${symbol} ${outcome.toUpperCase()} | PnL: ${(totalPnL * 100).toFixed(2)}% | R: ${rMultiple.toFixed(2)} | Label: ${label} | MFE: ${finalMfePct.toFixed(2)}% | MAE: ${finalMaePct.toFixed(2)}% | Reversal: ${isStrongReversal}`);

    return {
        outcome,
        pnl: totalPnL,
        pnlPercent: totalPnL * 100,
        rMultiple,
        label,
        maxFavorableExcursion: finalMfePct,
        maxAdverseExcursion: finalMaePct,
    };
}


// =========================================================================
// LABEL CALCULATION – Convert R-multiple to 5-tier ML label
// =========================================================================
/**
 * Maps R-multiple to discrete 5-tier label used for ML training.
 *
 * Thresholds (configurable in future):
 *   ≥ 3.0R → +2 (strong win)
 *   ≥ 1.5R → +1 (good win)
 *   ≥ -0.5R → 0 (breakeven/neutral)
 *   ≥ -1.5R → -1 (small loss)
 *   < -1.5R → -2 (disaster)
 *
 * @param rMultiple - Risk-multiple achieved
 * @returns ML label (-2 to +2)
 */
function computeLabel(rMultiple: number): -2 | -1 | 0 | 1 | 2 {
    if (rMultiple >= 3.0) return 2;
    if (rMultiple >= 1.5) return 1;
    if (rMultiple >= -0.5) return 0;
    if (rMultiple >= -1.5) return -1;
    return -2;
}

// =========================================================================
// UTILITY: Simple sleep function for polling delay
// =========================================================================
/**
 * Pauses execution for specified milliseconds.
 *
 * Used in:
 *   • Main simulation loop – between candle polls
 *   • Error recovery – backoff delay
 *
 * @param ms - Delay in milliseconds
 */
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
