// src/lib/services/simulateTrade.ts
// =============================================================================
// HIGH-PRECISION TRADE SIMULATOR – CORE OF ML LABELING ENGINE
//
// Purpose:
//   • Simulate every generated signal with real 1m market data
//   • Accurately calculate PnL, R-multiple, and Max Excursions (MFE/MAE)
//   • Provide 5-tier labels (-2 to +2) for ML training
//   • Support partial take-profits and timeout exits
//   • Store full lifecycle in DB for analysis and excursion stats
//
// Simulation constraints:
//   • Uses 1m candles (config.scanner.simulationTimeframe) regardless of
//     the strategy's primary timeframe — sim accuracy is independent
//   • Maximum 10 candles (≈10 min) plus a wall-clock hard-stop at
//     SIM_HARD_STOP_MS to handle exchange data gaps gracefully
//   • No trailing stops — keeps sim focused on raw signal edge
//
// R-multiple calculation:
//   • Uses the actual SL distance from signal.stopLoss when available
//   • Falls back to FALLBACK_RISK_PCT only when no SL is set
//   • This makes rMultiple meaningful for ML training
//
// DB storage scaling (two ×1e4 layers → effective ×1e8 in DB):
//   storeAndFinalizeSimulation passes: Math.round(boundedMfe * 1e4)
//   updateCompletedSimulation stores:  Math.round(value * 1e4)
//   Effective DB value:                boundedMfe * 1e8
//   excursionCache reads back with:    / 1e8  (correct)
// =============================================================================

import { ExchangeService } from './exchange';
import { dbService } from '../db';
import { createLogger } from '../logger';
import type { TradeSignal } from '../../types';
import { config } from '../config/settings';
import { excursionCache } from './excursionHistoryCache';
import { mlService } from './mlService';

const logger = createLogger('simulateTrade');

// Wall-clock hard stop: if 10 valid candles are never collected within this
// window (e.g. due to repeated data gaps), force a timeout exit anyway.
// 10 candles × 60 s × 3 = 30 min maximum real time, generous enough to handle
// brief exchange outages without letting a sim run forever.
const SIM_HARD_STOP_MS = 30 * 60 * 1000;

// Fallback risk % used ONLY when signal has no stopLoss set at all.
const FALLBACK_RISK_PCT = 0.015;

export interface SimulationResult {
    outcome: 'tp' | 'partial_tp' | 'sl' | 'timeout';
    pnl: number;
    pnlPercent: number;
    rMultiple: number;
    label: -2 | -1 | 0 | 1 | 2;
    maxFavorableExcursion: number;
    maxAdverseExcursion: number;
    duration_ms: number;
    timeToMaxMFE_ms: number;
    timeToMaxMAE_ms: number;
    exitPrice?: number;
    partialTpHit?: boolean;
}

export async function simulateTrade(
    exchangeService: ExchangeService,
    symbol: string,
    signal: TradeSignal,
    entryPrice: number,
    features: number[],
    correlationId: string,
): Promise<SimulationResult> {

    if (entryPrice <= 0) {
        throw new Error(`simulateTrade: invalid entry price for ${symbol}: ${entryPrice}`);
    }

    const isLong = signal.signal === 'buy';

    // Simulation always polls 1m candles — independent of strategy timeframe.
    const pollIntervalMs = ExchangeService.toTimeframeMs(config.scanner.simulationTimeframe);

    logger.info(`[SIM] ${symbol} ${isLong ? 'LONG' : 'SHORT'} started`, {
        correlationId,
        entryPrice: entryPrice.toFixed(8),
        stopLoss: signal.stopLoss?.toFixed(8) ?? 'none',
        takeProfit: signal.takeProfit?.toFixed(8) ?? 'none',
        partialTps: signal.takeProfitLevels?.length ?? 0,
    });

    const startTime = Date.now();
    const hardStopAt = startTime + SIM_HARD_STOP_MS;
    const signalId = correlationId;

    const tracking = initializeTrackingVariables(signal, entryPrice, startTime);

    await dbService.createNewSimulation(
        signalId, signal.symbol, signal.signal as 'buy' | 'sell',
        entryPrice, startTime, features,
    );

    // ─────────────────────────────────────────────────────────────────────────
    // MAIN SIMULATION LOOP
    // Processes up to 10 valid 1m candles. Candle skips (null / invalid data)
    // do NOT count toward the 10-candle limit, but the wall-clock hard stop
    // guarantees we always exit within SIM_HARD_STOP_MS regardless.
    // ─────────────────────────────────────────────────────────────────────────
    while (tracking.candleCount < 10 && tracking.remainingPosition > 0.01) {

        // Hard stop: if the exchange has been unavailable too long, give up.
        if (Date.now() >= hardStopAt) {
            logger.warn(`[SIM] ${symbol} hit wall-clock hard stop after ${((Date.now() - startTime) / 60000).toFixed(1)} min`, {
                correlationId, candlesProcessed: tracking.candleCount,
            });
            break; // falls through to timeout exit below
        }

        await waitForNextCandle(pollIntervalMs);

        // getCurrentCandle already validates internally; null = skip this tick
        const candle = await getCurrentCandle(exchangeService, symbol);
        if (!candle) {
            logger.debug(`[SIM] ${symbol} – no valid candle yet, skipping tick`, { correlationId });
            continue;
        }

        const { high, low } = candle;

        // ── Update MFE / MAE extremes ─────────────────────────────────────────
        const excursionUpdate = updateExcursionExtremes(
            isLong, high, low,
            tracking.bestFavorablePrice, tracking.bestAdversePrice,
            Date.now(),
            tracking.timeOfMaxFavorable, tracking.timeOfMaxAdverse,
        );
        tracking.bestFavorablePrice = excursionUpdate.newBestFavorable;
        tracking.bestAdversePrice = excursionUpdate.newBestAdverse;
        tracking.timeOfMaxFavorable = excursionUpdate.newTimeOfMaxFavorable;
        tracking.timeOfMaxAdverse = excursionUpdate.newTimeOfMaxAdverse;

        // ── Partial take-profits ──────────────────────────────────────────────
        const partialResult = checkPartialTakeProfits(
            signal, isLong, high, low,
            entryPrice, tracking.remainingPosition, tracking.totalPnL,
        );
        if (partialResult?.hit) {
            tracking.remainingPosition = partialResult.newRemaining;
            tracking.totalPnL = partialResult.newTotalPnL;

            if (tracking.remainingPosition <= 0.01) {
                return storeAndFinalizeSimulation({
                    outcome: 'partial_tp', signalId, startTime,
                    totalPnL: tracking.totalPnL, entryPrice, signal,
                    bestFavorablePrice: tracking.bestFavorablePrice,
                    bestAdversePrice: tracking.bestAdversePrice,
                    timeOfMaxFavorable: tracking.timeOfMaxFavorable,
                    timeOfMaxAdverse: tracking.timeOfMaxAdverse,
                    symbol, features,
                });
            }
        }

        // ── Full take-profit ──────────────────────────────────────────────────
        if (checkFullTakeProfit(signal, isLong, high, low)) {
            const fullTpPnL = tracking.totalPnL + (isLong
                ? (signal.takeProfit! - entryPrice) / entryPrice * tracking.remainingPosition
                : (entryPrice - signal.takeProfit!) / entryPrice * tracking.remainingPosition);

            return storeAndFinalizeSimulation({
                outcome: 'tp', signalId, startTime,
                totalPnL: fullTpPnL, entryPrice, signal,
                bestFavorablePrice: tracking.bestFavorablePrice,
                bestAdversePrice: tracking.bestAdversePrice,
                timeOfMaxFavorable: tracking.timeOfMaxFavorable,
                timeOfMaxAdverse: tracking.timeOfMaxAdverse,
                symbol, features,
            });
        }

        // ── Stop-loss ─────────────────────────────────────────────────────────
        if (checkStopLoss(isLong, low, high, tracking.currentStopLoss)) {
            const slPnL = tracking.totalPnL + (isLong
                ? (tracking.currentStopLoss! - entryPrice) / entryPrice * tracking.remainingPosition
                : (entryPrice - tracking.currentStopLoss!) / entryPrice * tracking.remainingPosition);

            return storeAndFinalizeSimulation({
                outcome: 'sl', signalId, startTime,
                totalPnL: slPnL, entryPrice, signal,
                bestFavorablePrice: tracking.bestFavorablePrice,
                bestAdversePrice: tracking.bestAdversePrice,
                timeOfMaxFavorable: tracking.timeOfMaxFavorable,
                timeOfMaxAdverse: tracking.timeOfMaxAdverse,
                symbol, features,
            });
        }

        tracking.candleCount++;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // TIMEOUT – forced exit (10 candles elapsed or hard stop hit)
    // Use the midpoint of the last candle for a neutral exit price rather than
    // the worst-case extreme, which was inflating negative PnL on 76% of trades.
    // ─────────────────────────────────────────────────────────────────────────
    const finalCandle = await getCurrentCandle(exchangeService, symbol);
    const exitPrice = finalCandle
        ? (finalCandle.high + finalCandle.low) / 2   // midpoint — neutral
        : entryPrice;                                 // fallback if no data

    const timeoutPnL = isLong
        ? (exitPrice - entryPrice) / entryPrice * tracking.remainingPosition
        : (entryPrice - exitPrice) / entryPrice * tracking.remainingPosition;

    return storeAndFinalizeSimulation({
        outcome: 'timeout', signalId, startTime,
        totalPnL: timeoutPnL, entryPrice, signal,
        bestFavorablePrice: tracking.bestFavorablePrice,
        bestAdversePrice: tracking.bestAdversePrice,
        timeOfMaxFavorable: tracking.timeOfMaxFavorable,
        timeOfMaxAdverse: tracking.timeOfMaxAdverse,
        symbol, features,
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// TRACKING VARIABLE INITIALIZATION
// ─────────────────────────────────────────────────────────────────────────────

function initializeTrackingVariables(
    signal: TradeSignal,
    entryPrice: number,
    startTime: number,
): {
    isLong: boolean;
    currentStopLoss: number | null;
    bestFavorablePrice: number;
    bestAdversePrice: number;
    timeOfMaxFavorable: number;
    timeOfMaxAdverse: number;
    remainingPosition: number;
    totalPnL: number;
    candleCount: number;
} {
    const isLong = signal.signal === 'buy';

    let currentStopLoss: number | null = null;
    if (signal.stopLoss !== undefined && signal.stopLoss > 0) {
        const sl = Number(signal.stopLoss.toFixed(8));
        if (isLong && sl >= entryPrice) {
            logger.warn(`initializeTrackingVariables: long SL >= entry – ignoring`, {
                symbol: signal.symbol, entry: entryPrice, sl,
            });
        } else if (!isLong && sl <= entryPrice) {
            logger.warn(`initializeTrackingVariables: short SL <= entry – ignoring`, {
                symbol: signal.symbol, entry: entryPrice, sl,
            });
        } else {
            currentStopLoss = sl;
        }
    }

    return {
        isLong,
        currentStopLoss,
        bestFavorablePrice: entryPrice,
        bestAdversePrice: entryPrice,
        timeOfMaxFavorable: startTime,
        timeOfMaxAdverse: startTime,
        remainingPosition: 1.0,
        totalPnL: 0.0,
        candleCount: 0,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// CANDLE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

async function waitForNextCandle(pollIntervalMs: number): Promise<void> {
    const ms = pollIntervalMs > 0 ? pollIntervalMs : 1000;
    await new Promise<void>(resolve => setTimeout(resolve, ms));
}

/**
 * Returns the latest completed candle's high/low, or null if data is missing
 * or invalid. All validation is performed here so callers don't need to
 * re-validate — the old separate validateCandle() call in the loop is removed.
 */
async function getCurrentCandle(
    exchangeService: ExchangeService,
    symbol: string,
): Promise<{ high: number; low: number } | null> {

    const rawData = await exchangeService.getOHLCV(symbol, config.scanner.simulationTimeframe);

    if (!rawData || !Array.isArray(rawData.timestamps) || rawData.timestamps.length < 2) {
        return null;
    }

    const high = rawData.highs[rawData.highs.length - 1];
    const low = rawData.lows[rawData.lows.length - 1];

    if (
        typeof high !== 'number' || typeof low !== 'number' ||
        isNaN(high) || isNaN(low) || !isFinite(high) || !isFinite(low) ||
        high <= 0 || low <= 0 || low > high
    ) {
        logger.warn(`getCurrentCandle: invalid values for ${symbol}`, { high, low });
        return null;
    }

    // Sanity check: reject extreme single-candle moves (exchange glitches)
    const prevClose = rawData.closes[rawData.closes.length - 2];
    if (!isNaN(prevClose) && prevClose > 0 &&
        (high > prevClose * 20 || low < prevClose / 20)) {
        logger.warn(`getCurrentCandle: extreme candle detected – skipping`, {
            symbol, high, low, prevClose,
        });
        return null;
    }

    return { high, low };
}

// ─────────────────────────────────────────────────────────────────────────────
// EXCURSION TRACKING
// ─────────────────────────────────────────────────────────────────────────────

function updateExcursionExtremes(
    isLong: boolean,
    high: number,
    low: number,
    bestFavorablePrice: number,
    bestAdversePrice: number,
    currentTime: number,
    prevTimeFavorable: number,
    prevTimeAdverse: number,
): {
    newBestFavorable: number;
    newBestAdverse: number;
    newTimeOfMaxFavorable: number;
    newTimeOfMaxAdverse: number;
} {
    let newBestFavorable = bestFavorablePrice;
    let newBestAdverse = bestAdversePrice;
    let newTimeFavorable = prevTimeFavorable;
    let newTimeAdverse = prevTimeAdverse;

    if (isNaN(high) || isNaN(low) || high <= 0 || low <= 0 || low > high) {
        return { newBestFavorable, newBestAdverse, newTimeOfMaxFavorable: newTimeFavorable, newTimeOfMaxAdverse: newTimeAdverse };
    }

    if (isLong) {
        if (high > bestFavorablePrice) { newBestFavorable = high; newTimeFavorable = currentTime; }
        if (low < bestAdversePrice) { newBestAdverse = low; newTimeAdverse = currentTime; }
    } else {
        if (low < bestFavorablePrice) { newBestFavorable = low; newTimeFavorable = currentTime; }
        if (high > bestAdversePrice) { newBestAdverse = high; newTimeAdverse = currentTime; }
    }

    return { newBestFavorable, newBestAdverse, newTimeOfMaxFavorable: newTimeFavorable, newTimeOfMaxAdverse: newTimeAdverse };
}

// ─────────────────────────────────────────────────────────────────────────────
// EXIT CONDITION CHECKS
// ─────────────────────────────────────────────────────────────────────────────

function checkPartialTakeProfits(
    signal: TradeSignal,
    isLong: boolean,
    high: number,
    low: number,
    entryPrice: number,
    remainingPosition: number,
    totalPnL: number,
): { hit: boolean; newRemaining: number; newTotalPnL: number } | null {

    if (!signal.takeProfitLevels?.length || remainingPosition <= 0.01) return null;

    const EPSILON = 1e-8;
    const sortedLevels = [...signal.takeProfitLevels].sort((a, b) =>
        isLong ? a.price - b.price : b.price - a.price
    );

    let newRemaining = remainingPosition;
    let newTotalPnL = totalPnL;
    let anyHit = false;

    for (const level of sortedLevels) {
        if (newRemaining < level.weight - EPSILON) continue;

        const tpHit = isLong
            ? high >= level.price - EPSILON
            : low <= level.price + EPSILON;

        if (tpHit) {
            const pnlThis = isLong
                ? (level.price - entryPrice) / entryPrice
                : (entryPrice - level.price) / entryPrice;

            newTotalPnL += pnlThis * level.weight;
            newRemaining -= level.weight;
            anyHit = true;
        }
    }

    if (!anyHit) return null;

    return { hit: true, newRemaining: Math.max(0, newRemaining), newTotalPnL };
}

function checkFullTakeProfit(
    signal: TradeSignal,
    isLong: boolean,
    high: number,
    low: number,
): boolean {
    if (!signal.takeProfit || signal.takeProfit <= 0 || isNaN(signal.takeProfit)) return false;
    const EPSILON = 1e-8;
    return isLong ? high >= signal.takeProfit - EPSILON : low <= signal.takeProfit + EPSILON;
}

function checkStopLoss(
    isLong: boolean,
    low: number,
    high: number,
    currentStopLoss: number | null,
): boolean {
    if (!currentStopLoss || currentStopLoss <= 0 || isNaN(currentStopLoss)) return false;
    const EPSILON = 1e-8;
    return isLong ? low <= currentStopLoss + EPSILON : high >= currentStopLoss - EPSILON;
}

// ─────────────────────────────────────────────────────────────────────────────
// FINALIZE & PERSIST
// ─────────────────────────────────────────────────────────────────────────────

async function storeAndFinalizeSimulation(params: {
    signalId: string;
    symbol: string;
    signal: TradeSignal;
    entryPrice: number;
    startTime: number;
    outcome: 'tp' | 'partial_tp' | 'sl' | 'timeout';
    totalPnL: number;
    bestFavorablePrice: number;
    bestAdversePrice: number;
    timeOfMaxFavorable: number;
    timeOfMaxAdverse: number;
    features?: number[];
}): Promise<SimulationResult> {

    const {
        signalId, symbol, signal, entryPrice, startTime, outcome,
        totalPnL, bestFavorablePrice, bestAdversePrice,
        timeOfMaxFavorable, timeOfMaxAdverse, features,
    } = params;

    const isLong = signal.signal === 'buy';
    const endTime = Date.now();
    const durationMs = endTime - startTime;

    // ── Excursions as % of entry ──────────────────────────────────────────────
    const rawMfeDelta = isLong ? bestFavorablePrice - entryPrice : entryPrice - bestFavorablePrice;
    const rawMaeDelta = isLong ? entryPrice - bestAdversePrice : bestAdversePrice - entryPrice;

    const mfePct = (rawMfeDelta / entryPrice) * 100;
    const maePct = -Math.abs((rawMaeDelta / entryPrice) * 100);

    const boundedMfe = Math.max(0, Math.min(10000, mfePct));
    const boundedMae = Math.max(-10000, Math.min(0, maePct));

    // ── Time to extremes ──────────────────────────────────────────────────────
    const timeToMfeMs = Math.max(0, timeOfMaxFavorable - startTime);
    const timeToMaeMs = Math.max(0, timeOfMaxAdverse - startTime);

    // ── R-multiple — use actual SL distance when available ───────────────────
    // This makes rMultiple meaningful for ML training rather than a fixed-
    // denominator approximation. Falls back to FALLBACK_RISK_PCT only when the
    // signal truly has no stopLoss (edge case).
    let riskPct: number;
    if (signal.stopLoss && signal.stopLoss > 0) {
        riskPct = Math.abs(entryPrice - signal.stopLoss) / entryPrice;
        // Safety: clamp to avoid division by near-zero if SL is almost at entry
        riskPct = Math.max(riskPct, 0.0001);
    } else {
        riskPct = FALLBACK_RISK_PCT;
    }
    const rMultiple = totalPnL / riskPct;

    // ── Label via excursion-dominant scoring ──────────────────────────────────
    const scoreResult = excursionCache.computeSimulationScore({
        signalId, timestamp: endTime,
        direction: isLong ? 'buy' : 'sell',
        outcome, rMultiple,
        mfe: boundedMfe, mae: boundedMae,
        durationMs, timeToMFE_ms: timeToMfeMs, timeToMAE_ms: timeToMaeMs,
    });
    const label = excursionCache.mapScoreToLabel(scoreResult.totalScore);

    // ── Persist to DB ─────────────────────────────────────────────────────────
    try {
        dbService.updateCompletedSimulation(signalId, {
            tpLevels: signal.takeProfitLevels ?? undefined,
            stoploss: signal.stopLoss,
            trailingDist: signal.trailingStopDistance,
            closedAt: endTime,
            outcome,
            pnl: Math.round(totalPnL * 1e8),
            rMultiple: Math.round(rMultiple * 1e4),
            label,
            maxFavorableExcursion: Math.round(boundedMfe * 1e4),
            maxAdverseExcursion: Math.round(boundedMae * 1e4),
            durationMs,
            timeToMFEMs: timeToMfeMs,
            timeToMAEMs: timeToMaeMs,
            features: features ?? [],
        });
    } catch (err) {
        logger.error('storeAndFinalizeSimulation: DB write failed', {
            symbol, signalId, outcome,
            error: err instanceof Error ? err.message : String(err),
        });
        throw err;
    }

    // ── Periodic ML retraining trigger ────────────────────────────────────────
    if (config.ml.trainingEnabled) {
        const count = await dbService.getSampleCount();
        if (count >= config.ml.minSamplesToTrain && count % 20 === 0) {
            await mlService.retrain();
        }
    }

    // ── Update excursion cache ────────────────────────────────────────────────
    excursionCache.addCompletedSimulation(symbol, {
        signalId, timestamp: endTime,
        direction: isLong ? 'buy' : 'sell',
        outcome, rMultiple, label,
        mfe: boundedMfe, mae: boundedMae,
        durationMs, timeToMFE_ms: timeToMfeMs, timeToMAE_ms: timeToMaeMs,
    });

    logger.info(`[SIM] ${symbol} FINALIZED – ${outcome.toUpperCase()}`, {
        signalId, side: isLong ? 'LONG' : 'SHORT', outcome,
        pnlPct: (totalPnL * 100).toFixed(2) + '%',
        rMultiple: rMultiple.toFixed(3),
        riskPct: (riskPct * 100).toFixed(4) + '%',
        label, score: scoreResult.totalScore.toFixed(2),
        durationMin: (durationMs / 60000).toFixed(2),
        mfePct: boundedMfe.toFixed(3), maePct: boundedMae.toFixed(3),
        timeToMFE: (timeToMfeMs / 1000).toFixed(1) + 's',
        timeToMAE: (timeToMaeMs / 1000).toFixed(1) + 's',
    });

    return {
        outcome, pnl: totalPnL, pnlPercent: totalPnL * 100,
        rMultiple, label,
        maxFavorableExcursion: boundedMfe,
        maxAdverseExcursion: boundedMae,
        duration_ms: durationMs,
        timeToMaxMFE_ms: timeToMfeMs,
        timeToMaxMAE_ms: timeToMaeMs,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// LEGACY EXPORT — kept for any external callers that import computeLabel
// ─────────────────────────────────────────────────────────────────────────────

export function computeLabel(rMultiple: number): -2 | -1 | 0 | 1 | 2 {
    if (rMultiple >= 3.0) return 2;
    if (rMultiple >= 1.5) return 1;
    if (rMultiple >= -0.5) return 0;
    if (rMultiple >= -1.5) return -1;
    return -2;
}
