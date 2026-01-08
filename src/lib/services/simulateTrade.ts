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
import { config } from '../config/settings';
import { excursionCache } from './excursionHistoryCache';

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
/**
 * High-fidelity trade simulator – runs a complete simulated trade from signal generation.
 *
 * Core Responsibilities:
 *   • Polls real-time market data (3m candles) every 15 seconds
 *   • Tracks price extremes to compute accurate Max Favorable Excursion (MFE) and Max Adverse Excursion (MAE)
 *   • Supports trailing stops, single TP, and multi-level partial take-profits
 *   • Provides interim excursion updates every 5 minutes for real-time regime awareness
 *   • Handles timeout exits after 1 hour
 *   • Validates candle data to prevent corruption from exchange glitches
 *   • Caps extreme values to protect downstream stats and ML training
 *   • Fires-and-forgets DB updates without blocking the simulation loop
 *
 * Key Design Principles:
 *   • Never blocks the main scanner – all DB calls are non-critical
 *   • MFE stored as positive %, MAE as negative % (matches Strategy expectations)
 *   • Robust against bad candles (NaN, zero prices, unrealistic spikes)
 *   • Comprehensive logging for debugging simulation behavior
 *
 * @param exchangeService - Live market data provider
 * @param symbol - Trading pair (e.g., 'TON/USDT')
 * @param signal - Full TradeSignal from Strategy (includes SL, TP, trailing, etc.)
 * @param entryPrice - Exact price at signal time
 * @returns SimulationResult with outcome, PnL, R-multiple, label, and bounded excursions
 */
export async function simulateTrade(
    exchangeService: ExchangeService,
    symbol: string,
    signal: TradeSignal,
    entryPrice: number
): Promise<SimulationResult> {

    // =========================================================================
    // 0. Initial Safety Checks
    // =========================================================================
    if (entryPrice <= 0) {
        throw new Error(`Invalid entryPrice for ${symbol}: ${entryPrice} (must be > 0)`);
    }

    const isLong = signal.signal === 'buy';
    const direction: 'buy' | 'sell' = signal.signal === 'buy' ? 'buy' : 'sell';
    const hasTrailing = !!signal.trailingStopDistance;

    // Current stop-loss (updated dynamically if trailing)
    let currentStopLoss = signal.stopLoss ?? null;

    // Best price seen in favorable direction (used for trailing stop movement)
    let bestPrice = entryPrice;

    // Real-time excursion tracking
    let maxFavorablePrice = entryPrice;  // Highest (long) or lowest (short) price seen
    let maxAdversePrice = entryPrice;    // Lowest (long) or highest (short) price seen

    // Position and PnL tracking
    let remainingPosition = 1.0;         // Fraction of original position still open
    let totalPnL = 0.0;                   // Accumulated realized PnL

    // Timing configuration
    const startTime = Date.now();
    const timeoutMs = 60 * 60 * 1000;                    // 1 hour maximum simulation duration
    const pollIntervalMs = ExchangeService.toTimeframeMs(config.scanner.primaryTimeframe);
    const INTERIM_UPDATE_INTERVAL_MS = 5 * 60 * 1000;    // Update recent stats every 5 minutes
    let lastInterimUpdateTime = startTime;

    // =========================================================================
    // 1. Prepare TP levels for DB storage (if any)
    // =========================================================================
    const tpLevelsDb: { price: number; weight: number }[] = [];
    if (signal.takeProfit) {
        tpLevelsDb.push({ price: signal.takeProfit, weight: 1.0 });
    }
    if (signal.takeProfitLevels?.length) {
        tpLevelsDb.push(...signal.takeProfitLevels);
    }

    // =========================================================================
    // 2. Start simulation record in database
    // =========================================================================
    const signalId = await dbService.startSimulatedTrade({
        symbol,
        side: signal.signal as 'buy' | 'sell',
        entryPrice: Number(entryPrice.toFixed(8)),
        stopLoss: currentStopLoss ? Number(currentStopLoss.toFixed(8)) : null,
        trailingDist: signal.trailingStopDistance ? Number(signal.trailingStopDistance.toFixed(8)) : null,
        tpLevels: tpLevelsDb.length > 0 ? tpLevelsDb : null,
    });

    logger.info(`[SIM] ${symbol} ${isLong ? 'LONG' : 'SHORT'} started`, {
        signalId,
        entryPrice: entryPrice.toFixed(8),
        stopLoss: currentStopLoss?.toFixed(8) ?? 'none',
        trailing: hasTrailing,
    });

    // === ADD THIS: Register in in-memory cache ===
    excursionCache.updateOrAdd(symbol, signalId, {
        direction,
        mfe: 0,
        mae: 0,
        timestamp: startTime,
    }, true);

    // =========================================================================
    // 3. Main Simulation Loop – runs until exit or timeout
    // =========================================================================
    while (Date.now() - startTime < timeoutMs && remainingPosition > 0.01) {
        try {
            // Fetch latest cached OHLCV data
            const raw = exchangeService.getPrimaryOhlcvData(symbol);
            if (!raw || raw.length < 2) {
                await sleep(pollIntervalMs);
                continue;
            }

            const latestCandle = raw[raw.length - 1];
            const high = Number(latestCandle[2]);
            const low = Number(latestCandle[3]);

            // Validate candle integrity – skip corrupted or unrealistic data
            if (
                isNaN(high) || isNaN(low) ||
                high <= 0 || low <= 0 ||
                low > high ||
                high > entryPrice * 500 ||   // Prevent absurd pumps (>500x)
                low < entryPrice / 500        // Prevent absurd dumps
            ) {
                logger.warn(`Invalid candle skipped during simulation`, {
                    symbol,
                    signalId,
                    high,
                    low,
                    entryPrice,
                });
                await sleep(pollIntervalMs);
                continue;
            }

            // Update excursion extremes
            if (isLong) {
                maxFavorablePrice = Math.max(maxFavorablePrice, high);
                maxAdversePrice = Math.min(maxAdversePrice, low);
            } else {
                maxFavorablePrice = Math.min(maxFavorablePrice, low);
                maxAdversePrice = Math.max(maxAdversePrice, high);
            }

            // Trailing stop movement
            if (hasTrailing && currentStopLoss !== null) {
                if (isLong && high > bestPrice) {
                    bestPrice = high;
                    const newStop = bestPrice - signal.trailingStopDistance!;
                    if (newStop > currentStopLoss) {
                        currentStopLoss = newStop;
                    }
                } else if (!isLong && low < bestPrice) {
                    bestPrice = low;
                    const newStop = bestPrice + signal.trailingStopDistance!;
                    if (newStop < currentStopLoss) {
                        currentStopLoss = newStop;
                    }
                }
            }

            // Partial Take-Profit Handling
            if (signal.takeProfitLevels?.length && remainingPosition > 0.01) {
                const sortedLevels = [...signal.takeProfitLevels].sort((a, b) =>
                    isLong ? a.price - b.price : b.price - a.price
                );

                let partialClosed = false;
                for (const level of sortedLevels) {
                    const tpHit = isLong ? high >= level.price : low <= level.price;
                    if (tpHit && remainingPosition >= level.weight) {
                        const pnlThisLevel = isLong
                            ? (level.price - entryPrice) / entryPrice
                            : (entryPrice - level.price) / entryPrice;

                        totalPnL += pnlThisLevel * level.weight;
                        remainingPosition -= level.weight;
                        partialClosed = true;

                        logger.debug(`[SIM] Partial TP hit`, {
                            symbol,
                            signalId,
                            level: level.price.toFixed(8),
                            weight: level.weight,
                            pnlThis: (pnlThisLevel * 100).toFixed(2),
                            remaining: remainingPosition.toFixed(3),
                        });

                        // Optional: interim update on partial close
                        void triggerInterimUpdate();
                    }
                }

                if (partialClosed && remainingPosition <= 0.01) {
                    return await finalizeSimulation(
                        'partial_tp',
                        startTime,
                        totalPnL,
                        signalId,
                        symbol,
                        entryPrice,
                        isLong,
                        maxFavorablePrice,
                        maxAdversePrice
                    );
                }
            }
            // Single Full Take-Profit
            else if (signal.takeProfit && remainingPosition > 0.01) {
                const tpHit = isLong ? high >= signal.takeProfit : low <= signal.takeProfit;
                if (tpHit) {
                    const pnlFull = isLong
                        ? (signal.takeProfit - entryPrice) / entryPrice
                        : (entryPrice - signal.takeProfit) / entryPrice;

                    totalPnL += pnlFull * remainingPosition;
                    remainingPosition = 0;
                    return await finalizeSimulation(
                        'tp',
                        startTime,
                        totalPnL,
                        signalId,
                        symbol,
                        entryPrice,
                        isLong,
                        maxFavorablePrice,
                        maxAdversePrice
                    );
                }
            }

            // Stop-Loss Check
            if (currentStopLoss && remainingPosition > 0.01) {
                const slHit = isLong ? low <= currentStopLoss : high >= currentStopLoss;
                if (slHit) {
                    const pnlSL = isLong
                        ? (currentStopLoss - entryPrice) / entryPrice
                        : (entryPrice - currentStopLoss) / entryPrice;

                    totalPnL += pnlSL * remainingPosition;
                    remainingPosition = 0;
                    return await finalizeSimulation(
                        'sl',
                        startTime,
                        totalPnL,
                        signalId,
                        symbol,
                        entryPrice,
                        isLong,
                        maxFavorablePrice,
                        maxAdversePrice
                    );
                }
            }

            // Interim Excursion Update (every 5 minutes)
            const now = Date.now();
            if (now - lastInterimUpdateTime >= INTERIM_UPDATE_INTERVAL_MS) {
                lastInterimUpdateTime = now;
                await triggerInterimUpdate();
            }

            await sleep(pollIntervalMs);
        } catch (err) {
            logger.error('Error in simulation loop', { symbol, signalId, error: err });
            await sleep(pollIntervalMs);
        }
    }

    // =========================================================================
    // 4. Timeout Exit – forced close at final candle
    // =========================================================================
    const finalRaw = exchangeService.getPrimaryOhlcvData(symbol);
    const lastCandle = finalRaw?.[finalRaw.length - 1];
    let exitPrice = lastCandle
        ? isLong ? Number(lastCandle[2]) : Number(lastCandle[3])  // high for long, low for short
        : entryPrice;

    // Validate final exit price
    if (isNaN(exitPrice) || exitPrice <= 0) {
        logger.warn(`Invalid timeout exit price, using entryPrice`, { symbol, signalId, exitPrice });
        exitPrice = entryPrice;
    }

    let timeoutPnl = isLong
        ? (exitPrice - entryPrice) / entryPrice
        : (entryPrice - exitPrice) / entryPrice;

    // Cap extreme timeout PnL
    if (timeoutPnl < -1) {
        logger.warn(`Timeout PnL capped to -100%`, { symbol, signalId, timeoutPnl });
        timeoutPnl = -1;
    }

    totalPnL += timeoutPnl * remainingPosition;
    return await finalizeSimulation(
        'timeout',
        startTime,
        totalPnL,
        signalId,
        symbol,
        entryPrice,
        isLong,
        maxFavorablePrice,
        maxAdversePrice
    );

    // =========================================================================
    // Helper: Update in-memory cache with current interim excursion state
    // =========================================================================
    /**
     * Updates the global in-memory cache with the current MFE/MAE of this running simulation.
     * Called every ~5 minutes during the simulation loop.
     * Enables real-time regime awareness for new signals on the same symbol.
     */
    async function triggerInterimUpdate(): Promise<void> {
        // Compute current excursions as percentages
        const currentMfePct = isLong
            ? ((maxFavorablePrice - entryPrice) / entryPrice) * 100
            : ((entryPrice - maxFavorablePrice) / entryPrice) * 100;

        const rawMaePct = isLong
            ? ((entryPrice - maxAdversePrice) / entryPrice) * 100
            : ((maxAdversePrice - entryPrice) / entryPrice) * 100;

        // MAE is negative by convention
        const currentMaePct = -Math.abs(rawMaePct);

        // Bound extreme values (safety)
        const boundedMfe = Math.max(0, Math.min(1000, currentMfePct));
        const boundedMae = Math.max(-1000, Math.min(0, currentMaePct));

        // Update the in-memory cache
        excursionCache.updateOrAdd(symbol, signalId, {
            mfe: boundedMfe,
            mae: boundedMae,
        }, true);

        logger.debug(`[SIM] Interim excursion cached`, {
            signalId,
            symbol,
            mfePct: boundedMfe.toFixed(2),
            maePct: boundedMae.toFixed(2),
        });
    }
}

/**
 * Finalizes a completed trade simulation.
 *
 * Responsibilities:
 *   • Caps unrealistic PnL values (prevents data corruption from bad candles)
 *   • Calculates the final R-multiple using a realistic fallback risk distance
 *   • Determines the 5-tier ML label based on R-multiple
 *   • Computes final Max Favorable Excursion (MFE) and Max Adverse Excursion (MAE) as percentages
 *   • Detects strong reversals (profitable in opposite direction → regime change signal)
 *   • Updates recent (time-bound) excursion stats in the denormalized symbolHistory table
 *   • Increments recent reverse count if a strong reversal occurred
 *   • Persists final outcome and metrics to the simulated_trades table
 *   • Logs a clear, structured summary for monitoring and debugging
 *   • Returns a clean SimulationResult for ML ingestion
 *
 * Important Conventions Used:
 *   • MFE is always ≥ 0 (best unrealized profit %)
 *   • MAE is always ≤ 0 (worst unrealized drawdown %, negative by convention)
 *   • This matches Strategy logic (e.g., checks like recentMae > threshold expect negative values)
 *
 * @param outcome - Reason for exit: 'tp', 'partial_tp', 'sl', or 'timeout'
 * @param totalPnL - Accumulated PnL as decimal (e.g., 0.023 = +2.3%, -0.45 = -45%)
 * @param signalId - Unique ID from startSimulatedTrade()
 * @param symbol - Trading pair (e.g., 'TON/USDT')
 * @param entryPrice - Price at which the simulated position was entered
 * @param isLong - true for long, false for short
 * @param maxFavorablePrice - Highest (long) or lowest (short) price seen during trade
 * @param maxAdversePrice - Lowest (long) or highest (short) price seen during trade
 * @returns Complete SimulationResult ready for ML training
 */
async function finalizeSimulation(
    outcome: 'tp' | 'partial_tp' | 'sl' | 'timeout',
    startTime: number,
    totalPnL: number,
    signalId: string,
    symbol: string,
    entryPrice: number,
    isLong: boolean,
    maxFavorablePrice: number,
    maxAdversePrice: number,
): Promise<SimulationResult> {

    // =========================================================================
    // 1. Safety: Cap extreme PnL values
    // =========================================================================
    if (totalPnL < -1) {
        logger.warn(`PnL capped from ${(totalPnL * 100).toFixed(4)}% to -100%`, { symbol, signalId });
        totalPnL = -1;
    }

    // =========================================================================
    // 2. Calculate R-multiple
    // =========================================================================
    const FALLBACK_RISK_PCT = 0.015; // 1.5%
    const rMultiple = totalPnL / FALLBACK_RISK_PCT;

    // =========================================================================
    // 3. Determine 5-tier ML label
    // =========================================================================
    const label = computeLabel(rMultiple);

    // =========================================================================
    // 4. Compute final excursion percentages
    // =========================================================================
    const rawMfeDelta = isLong
        ? maxFavorablePrice - entryPrice
        : entryPrice - maxFavorablePrice;
    const finalMfePct = (rawMfeDelta / entryPrice) * 100;

    const rawMaeDelta = isLong
        ? entryPrice - maxAdversePrice
        : maxAdversePrice - entryPrice;
    const finalMaePctRaw = (rawMaeDelta / entryPrice) * 100;
    const finalMaePct = -Math.abs(finalMaePctRaw); // Always negative or zero

    // Bound extremes
    const boundedMfePct = Math.max(0, Math.min(1000, finalMfePct));
    const boundedMaePct = Math.max(-1000, Math.min(0, finalMaePct));

    // =========================================================================
    // 5. Detect strong reversal
    // =========================================================================
    const expectedPositive = isLong ? totalPnL > 0 : totalPnL < 0;
    const isStrongReversal = Math.abs(label) >= 1 && !expectedPositive;

    // =========================================================================
    // 6. Final DB update + recent stats + reverse count
    // =========================================================================
    // closeSimulatedTrade handles everything: DB row, symbolHistory recalc, reverse increment
    await dbService.closeSimulatedTrade(
        signalId,
        outcome,
        totalPnL,
        rMultiple,
        label,
        maxFavorablePrice,
        maxAdversePrice
    );

    // === ADD THIS: Update cache with final values and complete ===
    excursionCache.updateOrAdd(symbol, signalId, {
        outcome,
        rMultiple,
        label,
        durationMs: Date.now() - startTime,  // Assuming startTime from outer scope
        mfe: boundedMfePct,
        mae: boundedMaePct,
    }, false);

    // =========================================================================
    // 7. Comprehensive logging
    // =========================================================================
    logger.info(`[SIM] ${symbol} ${outcome.toUpperCase()}`, {
        signalId,
        side: isLong ? 'LONG' : 'SHORT',
        pnlPct: (totalPnL * 100).toFixed(2),
        rMultiple: rMultiple.toFixed(3),
        label,
        startTime: new Date(startTime).toISOString(),
        endTime: new Date().toISOString(),
        durationMin: ((Date.now() - startTime) / 60000).toFixed(2),
        mfePct: boundedMfePct.toFixed(2),
        maePct: boundedMaePct.toFixed(2),
        reversal: isStrongReversal,
    });

    // =========================================================================
    // 8. Return result for ML ingestion
    // =========================================================================
    return {
        outcome,
        pnl: totalPnL,
        pnlPercent: totalPnL * 100,
        rMultiple,
        label,
        maxFavorableExcursion: boundedMfePct,
        maxAdverseExcursion: boundedMaePct,
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
export function computeLabel(rMultiple: number): -2 | -1 | 0 | 1 | 2 {
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
