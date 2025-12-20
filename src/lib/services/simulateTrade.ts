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
 * Main simulation function – runs a full trade lifecycle
 *
 * Called from:
 *   • MarketScanner.handleTradeSignal() – after every valid signal
 *
 * Process:
 *   1. Record start in DB (signalId generated)
 *   2. Poll latest candle every 15s
 *   3. Track price extremes (MFE/MAE)
 *   4. Handle trailing stop, partial/full TP, SL
 *   5. Exit on timeout (1 hour max)
 *   6. Calculate final results and close DB record
 *
 * @param exchangeService - For fetching real-time OHLCV data
 * @param symbol - Trading pair
 * @param signal - Full TradeSignal from Strategy
 * @param entryPrice - Exact entry price at signal time
 * @returns Complete simulation outcome
 */
export async function simulateTrade(
    exchangeService: ExchangeService,
    symbol: string,
    signal: TradeSignal,
    entryPrice: number
): Promise<SimulationResult> {
    // Safety check – prevent division by zero later
    if (entryPrice <= 0) {
        throw new Error('Invalid entryPrice: must be positive');
    }

    const isLong = signal.signal === 'buy';
    const hasTrailing = !!signal.trailingStopDistance;
    let currentStopLoss = signal.stopLoss ?? null;  // Can be updated by trailing
    let bestPrice = entryPrice;                     // Best price in favorable direction

    const startTime = Date.now();
    const timeoutMs = 60 * 60 * 1000;     // Maximum simulation duration: 1 hour
    const pollIntervalMs = 15_000;       // Poll frequency: every 15 seconds

    // Track price extremes for excursion calculation
    let maxFavorablePrice = entryPrice;
    let maxAdversePrice = entryPrice;

    // Position tracking for partial exits
    let remainingPosition = 1.0;  // Fraction of original position (1.0 = full)
    let totalPnL = 0.0;           // Accumulated PnL from partial exits

    // === Build proper TP levels for DB record ===
    const tpLevelsDb: { price: number; weight: number }[] = [];
    if (signal.takeProfit) {
        tpLevelsDb.push({ price: signal.takeProfit, weight: 1.0 });
    }
    if (signal.takeProfitLevels && signal.takeProfitLevels.length > 0) {
        tpLevelsDb.push(...signal.takeProfitLevels);
    }

    // === DB: Record simulation start ===
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
    // MAIN SIMULATION LOOP – runs until exit condition or timeout
    // =========================================================================
    while (Date.now() - startTime < timeoutMs && remainingPosition > 0.01) {
        try {
            // Fetch latest candle data
            const raw = exchangeService.getPrimaryOhlcvData(symbol);
            if (!raw || raw.length < 2) {
                await sleep(pollIntervalMs);
                continue;
            }

            const candle = raw[raw.length - 1];
            const high = Number(candle[2]);
            const low = Number(candle[3]);

            // Update MFE/MAE tracking
            if (isLong) {
                maxFavorablePrice = Math.max(maxFavorablePrice, high);
                maxAdversePrice = Math.min(maxAdversePrice, low);
            } else {
                maxFavorablePrice = Math.min(maxFavorablePrice, low);
                maxAdversePrice = Math.max(maxAdversePrice, high);
            }

            // Trailing Stop Update – moves SL in favorable direction
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

            // Take Profit Handling – supports partial levels
            if (signal.takeProfitLevels && signal.takeProfitLevels.length > 0 && remainingPosition > 0.01) {
                // Sort levels closest first for proper sequential hitting
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
                    }
                }

                // All partial TPs filled → exit
                if (partialClosed && remainingPosition <= 0.01) {
                    return await finalize('partial_tp', totalPnL, signalId, symbol, entryPrice, isLong, maxFavorablePrice, maxAdversePrice);
                }
            }
            // Single full TP
            else if (signal.takeProfit && remainingPosition > 0.01) {
                const tpHit = isLong ? high >= signal.takeProfit : low <= signal.takeProfit;
                if (tpHit) {
                    const pnlThis = isLong
                        ? (signal.takeProfit - entryPrice) / entryPrice
                        : (entryPrice - signal.takeProfit) / entryPrice;

                    totalPnL += pnlThis * remainingPosition;
                    remainingPosition = 0;

                    return await finalize('tp', totalPnL, signalId, symbol, entryPrice, isLong, maxFavorablePrice, maxAdversePrice);
                }
            }

            // Stop Loss Check
            if (currentStopLoss && remainingPosition > 0.01) {
                const slHit = isLong ? low <= currentStopLoss : high >= currentStopLoss;
                if (slHit) {
                    const pnlThis = isLong
                        ? (currentStopLoss - entryPrice) / entryPrice
                        : (entryPrice - currentStopLoss) / entryPrice;

                    totalPnL += pnlThis * remainingPosition;
                    remainingPosition = 0;

                    return await finalize('sl', totalPnL, signalId, symbol, entryPrice, isLong, maxFavorablePrice, maxAdversePrice);
                }
            }

            // Wait before next poll
            await sleep(pollIntervalMs);
        } catch (err) {
            logger.error('Simulation loop error', { symbol, error: err });
            await sleep(pollIntervalMs);
        }
    }

    // =========================================================================
    // TIMEOUT EXIT – close at current price after max duration
    // =========================================================================
    const finalRaw = exchangeService.getPrimaryOhlcvData(symbol);
    const last = finalRaw?.[finalRaw.length - 1];
    const exitPrice = last
        ? isLong ? Number(last[2]) : Number(last[3])  // Use high for long, low for short
        : entryPrice;

    const finalPnl = isLong
        ? (exitPrice - entryPrice) / entryPrice
        : (entryPrice - exitPrice) / entryPrice;

    totalPnL += finalPnl * remainingPosition;

    return await finalize('timeout', totalPnL, signalId, symbol, entryPrice, isLong, maxFavorablePrice, maxAdversePrice);
}

// =============================================================================
// FINALIZE & SAVE TO DB – Complete simulation and persist results
// =============================================================================
/**
 * Finalizes a simulation: calculates outcomes, normalizes excursions,
 * saves everything to DB, and returns typed result for ML ingestion.
 *
 * Called from:
 *   • Main simulation loop – on TP, partial TP, SL, or timeout exit
 *
 * Responsibilities:
 *   • Compute R-multiple using fallback risk (1.5% if no SL)
 *   • Assign 5-tier label based on R-multiple
 *   • Normalize MFE/MAE to percentage of entry price
 *   • Store high-precision values in DB (×1e8 for PnL, ×1e4 for % and R)
 *   • Update symbolHistory excursion averages
 *   • Rich logging for monitoring simulation quality
 *
 * @private – only called internally from simulateTrade()
 */
async function finalize(
    outcome: 'tp' | 'partial_tp' | 'sl' | 'timeout',
    pnl: number,                       // Accumulated PnL as decimal (e.g., 0.023 = +2.3%)
    signalId: string,
    symbol: string,
    entryPrice: number,
    isLong: boolean,
    maxFavorablePrice: number,         // Best price reached in profit direction
    maxAdversePrice: number            // Worst price reached against position
): Promise<SimulationResult> {
    // Fallback risk distance if no explicit SL (1.5% of entry price)
    // Used to calculate R-multiple when trade didn't hit SL
    const riskDistance = entryPrice * 0.015; // 1.5%

    // R-multiple = PnL / initial risk distance
    const rMultiple = pnl / (riskDistance / entryPrice);

    // Convert R-multiple to 5-tier ML label
    const label = computeLabel(rMultiple);

    // Normalize Max Favorable Excursion to % of entry price
    const mfePct = normalizeExcursion(
        isLong ? maxFavorablePrice - entryPrice : entryPrice - maxFavorablePrice,
        entryPrice
    );

    // Normalize Max Adverse Excursion to % of entry price
    const maePct = normalizeExcursion(
        isLong ? entryPrice - maxAdversePrice : maxAdversePrice - entryPrice,
        entryPrice
    );

    // Close simulation record in DB with high-precision values
    // ×1e8 for PnL and prices, ×1e4 for percentages and R-multiple
    await dbService.closeSimulatedTrade(
        signalId,
        outcome === 'partial_tp' ? 'partial_tp' : outcome,
        Math.round(pnl * 1e8),                    // PnL ×1e8
        Math.round(rMultiple * 1e4),              // R ×1e4
        label,
        Math.round(mfePct * 1e4),                 // MFE % ×1e4
        Math.round(maePct * 1e4)                  // MAE % ×1e4
    );

    // Comprehensive log – confirms ML label is ready and shows excursion quality
    logger.info(`[SIM] ${symbol} ${outcome.toUpperCase()} | PnL: ${(pnl * 100).toFixed(2)}% | R: ${rMultiple.toFixed(2)} | Label: ${label} | MFE: ${mfePct.toFixed(2)}% | MAE: ${maePct.toFixed(2)}%`);

    // Return typed result for immediate ML ingestion
    return {
        outcome,
        pnl,
        pnlPercent: pnl * 100,
        rMultiple,
        label,
        maxFavorableExcursion: mfePct,
        maxAdverseExcursion: maePct,
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
