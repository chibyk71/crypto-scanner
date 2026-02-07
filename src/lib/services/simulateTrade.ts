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
}

/**
 * High-fidelity scalping trade simulator – runs a complete simulated trade
 * from signal generation using real-time 1-minute candles.
 *
 * Core constraints for scalping:
 *   - Maximum duration: exactly 10 candles (≈10 minutes on 1m timeframe)
 *   - No trailing stops (disabled to keep simulation focused on raw signal edge)
 *   - Early exits possible via fixed SL, TP, partial TP
 *   - Timeout forced at close of 10th candle
 *
 * Outputs rich result including:
 *   - outcome, PnL, label
 *   - max favorable / adverse excursion (%)
 *   - duration of the trade (ms)
 *   - time-to-max-MFE and time-to-max-MAE (ms since entry)
 *
 * @param exchangeService - provides real-time OHLCV data
 * @param symbol - trading pair (e.g. 'BTC/USDT')
 * @param signal - complete TradeSignal with direction, SL, TP(s), etc.
 * @param entryPrice - exact entry price at signal time
 * @returns SimulationResult with all metrics for ML / regime analysis
 */
export async function simulateTrade(
    exchangeService: ExchangeService,
    symbol: string,
    signal: TradeSignal,
    entryPrice: number
): Promise<SimulationResult> {
    // ────────────────────────────────────────────────────────────────
    // 0. EARLY VALIDATION – prevent invalid simulations early
    // ────────────────────────────────────────────────────────────────
    if (entryPrice <= 0) {
        throw new Error(`Invalid entry price for ${symbol}: ${entryPrice} (must be > 0)`);
    }

    // Determine direction once – used everywhere
    const isLong = signal.signal === 'buy';

    // Get polling interval from config (should match primary timeframe, e.g. 60_000 ms for 1m)
    const pollIntervalMs = ExchangeService.toTimeframeMs(config.scanner.primaryTimeframe);

    // ────────────────────────────────────────────────────────────────
    // 1. START DATABASE RECORD – generate unique signalId
    //    We log simulation start before entering the loop
    // ────────────────────────────────────────────────────────────────
    const signalId = await startSimulationInDatabase(symbol, signal, entryPrice);

    logger.info(`[SIM] ${symbol} ${isLong ? 'LONG' : 'SHORT'} started`, {
        signalId,
        entryPrice: entryPrice.toFixed(8),
        stopLoss: signal.stopLoss?.toFixed(8) ?? 'none',
        takeProfit: signal.takeProfit?.toFixed(8) ?? 'none',
        partialTps: signal.takeProfitLevels?.length ?? 0,
    });

    // ────────────────────────────────────────────────────────────────
    // 2. INITIALIZE ALL TRACKING VARIABLES
    //    Single source of truth for the entire simulation loop
    // ────────────────────────────────────────────────────────────────
    const startTime = Date.now();

    const tracking = initializeTrackingVariables(
        signal,
        entryPrice,
        startTime
    );

    // ────────────────────────────────────────────────────────────────
    // 3. MAIN SIMULATION LOOP – runs until exit or 10 candles reached
    // ────────────────────────────────────────────────────────────────
    while (tracking.candleCount < 10 && tracking.remainingPosition > 0.01) {
        // Wait for next candle data to become available
        await waitForNextCandle(pollIntervalMs);

        // Get latest candle high/low
        const candle = getCurrentCandle(exchangeService, symbol);
        if (!candle) {
            logger.warn(`No candle data yet for ${symbol} – waiting`, { signalId });
            continue;
        }

        const { high, low } = candle;

        // Validate candle (protect against exchange glitches, NaN, absurd spikes)
        if (!validateCandle(high, low, entryPrice)) {
            logger.warn(`Invalid candle skipped`, { symbol, signalId, high, low });
            continue;
        }

        // ── Update excursion extremes (MFE / MAE) ──────────────────────
        const excursionUpdate = updateExcursionExtremes(
            isLong,
            high,
            low,
            tracking.bestFavorablePrice,
            tracking.bestAdversePrice,
            Date.now(),
            tracking.timeOfMaxFavorable,  // ← previous favorable time
            tracking.timeOfMaxAdverse
        );

        // Apply updates (we re-assign so we keep immutable style inside loop)
        tracking.bestFavorablePrice = excursionUpdate.newBestFavorable;
        tracking.bestAdversePrice = excursionUpdate.newBestAdverse;
        tracking.timeOfMaxFavorable = excursionUpdate.newTimeOfMaxFavorable;
        tracking.timeOfMaxAdverse = excursionUpdate.newTimeOfMaxAdverse;

        // ── Check partial take-profits (if configured) ─────────────────
        const partialResult = checkPartialTakeProfits(
            signal,
            isLong,
            high,
            low,
            entryPrice,
            tracking.remainingPosition,
            tracking.totalPnL
        );

        if (partialResult && partialResult.hit) {
            tracking.remainingPosition = partialResult.newRemaining;
            tracking.totalPnL = partialResult.newTotalPnL;

            // If position fully closed via partials → exit with partial_tp
            if (tracking.remainingPosition <= 0.01) {
                return await finalizeSimulation(
                    'partial_tp',
                    signalId,
                    startTime,
                    tracking.totalPnL,
                    entryPrice,
                    isLong,
                    tracking.bestFavorablePrice,
                    tracking.bestAdversePrice,
                    tracking.timeOfMaxFavorable,
                    tracking.timeOfMaxAdverse,
                    symbol
                );
            }
        }

        // ── Check full single take-profit ──────────────────────────────
        if (checkFullTakeProfit(signal, isLong, high, low)) {
            const fullTpPnL = tracking.totalPnL + (isLong
                ? (signal.takeProfit! - entryPrice) / entryPrice * tracking.remainingPosition
                : (entryPrice - signal.takeProfit!) / entryPrice * tracking.remainingPosition);

            return await finalizeSimulation(
                'tp',
                signalId,
                startTime,
                fullTpPnL,
                entryPrice,
                isLong,
                tracking.bestFavorablePrice,
                tracking.bestAdversePrice,
                tracking.timeOfMaxFavorable,
                tracking.timeOfMaxAdverse,
                symbol
            );
        }

        // ── Check stop-loss (fixed only – no trailing) ─────────────────
        if (checkStopLoss(isLong, low, high, tracking.currentStopLoss)) {
            const slPnL = tracking.totalPnL + (isLong
                ? (tracking.currentStopLoss! - entryPrice) / entryPrice * tracking.remainingPosition
                : (entryPrice - tracking.currentStopLoss!) / entryPrice * tracking.remainingPosition);

            return await finalizeSimulation(
                'sl',
                signalId,
                startTime,
                slPnL,
                entryPrice,
                isLong,
                tracking.bestFavorablePrice,
                tracking.bestAdversePrice,
                tracking.timeOfMaxFavorable,
                tracking.timeOfMaxAdverse,
                symbol
            );
        }

        // If we reached here → candle processed, increment counter
        tracking.candleCount++;
    }

    // ────────────────────────────────────────────────────────────────
    // 4. TIMEOUT – forced exit after exactly 10 candles
    // ────────────────────────────────────────────────────────────────
    const finalCandle = getCurrentCandle(exchangeService, symbol);
    const exitPrice = finalCandle
        ? calculateExitPriceForTimeout(
            isLong,
            finalCandle.high,
            finalCandle.low,
            entryPrice
        )
        : entryPrice; // fallback – very rare

    const timeoutPnL = isLong
        ? (exitPrice - entryPrice) / entryPrice * tracking.remainingPosition
        : (entryPrice - exitPrice) / entryPrice * tracking.remainingPosition;

    return await finalizeSimulation(
        'timeout',
        signalId,
        startTime,
        timeoutPnL,
        entryPrice,
        isLong,
        tracking.bestFavorablePrice,
        tracking.bestAdversePrice,
        tracking.timeOfMaxFavorable,
        tracking.timeOfMaxAdverse,
        symbol
    );
}

/**
 * Records the start of a new simulated trade in the database.
 *
 * Purpose:
 *   - Creates a persistent record of every simulation for later analysis,
 *     auditing, ML training sample lookup, and debugging.
 *   - Generates a unique signalId that will be used throughout the simulation
 *     lifecycle (updates, final close, linking to excursions).
 *   - Stores all relevant signal parameters at the moment of generation.
 *
 * Why we do this early:
 *   - Even if simulation crashes or times out early, we still have the entry.
 *   - Allows correlating live trades back to their originating simulation.
 *
 * What gets stored (based on current DB schema expectations):
 *   - symbol, side (buy/sell), entry price
 *   - stop loss (if any)
 *   - take profit levels (single + multi-level if present)
 *   - trailing distance (kept for reference even though disabled in sim)
 *   - NEW: placeholders for duration_ms, timeToMFE_ms, timeToMAE_ms
 *     → these will be filled on closeSimulatedTrade()
 *   - timestamp (implicit via DB)
 *
 * @param symbol - Trading pair (e.g. 'BTC/USDT')
 * @param signal - Full TradeSignal object containing direction, SL, TP(s), etc.
 * @param entryPrice - Exact price at which the signal was generated
 * @returns signalId - Unique identifier for this simulation run
 * @throws Error if DB write fails (caught higher up in simulateTrade)
 */
async function startSimulationInDatabase(
    symbol: string,
    signal: TradeSignal,
    entryPrice: number
): Promise<string> {
    try {
        // Prepare TP levels for storage – support both single TP and multi-level
        const tpLevelsForDb: { price: number; weight: number }[] = [];

        // Add single takeProfit if present (weight = 1.0 = full position)
        if (signal.takeProfit) {
            tpLevelsForDb.push({
                price: Number(signal.takeProfit.toFixed(8)),
                weight: 1.0
            });
        }

        // Add multi-level take profits if configured
        if (signal.takeProfitLevels && signal.takeProfitLevels.length > 0) {
            tpLevelsForDb.push(
                ...signal.takeProfitLevels.map(level => ({
                    price: Number(level.price.toFixed(8)),
                    weight: level.weight
                }))
            );
        }

        // Call the database service to create the simulation record
        // This should return a unique ID (string or UUID depending on your DB setup)
        const signalId = await dbService.startSimulatedTrade({
            symbol: symbol.trim().toUpperCase(), // Normalize symbol for consistency
            side: signal.signal as 'buy' | 'sell', // Enforce type
            entryPrice: Number(entryPrice.toFixed(8)), // High precision storage
            stopLoss: signal.stopLoss ? Number(signal.stopLoss.toFixed(8)) : null,
            trailingDist: signal.trailingStopDistance
                ? Number(signal.trailingStopDistance.toFixed(8))
                : null, // Kept for reference even if not used in sim
            tpLevels: tpLevelsForDb.length > 0 ? tpLevelsForDb : null,
            durationMs: 0,
            timeToMFEMs: 0,
            timeToMAEMs: 0,
        });

        // Basic validation – make sure we got a valid ID back
        if (!signalId || typeof signalId !== 'string' || signalId.length < 4) {
            throw new Error(`Database returned invalid signalId: ${signalId}`);
        }

        logger.debug(`Simulation record created in DB`, {
            symbol,
            signalId,
            side: signal.signal,
            entryPrice: entryPrice.toFixed(8),
            tpCount: tpLevelsForDb.length,
            // Optional: log the new placeholders
            hasDurationPlaceholder: true,
            hasTimeToMFEPlaceholder: true,
            hasTimeToMAEPlaceholder: true
        });

        return signalId;

    } catch (err: any) {
        // Critical failure – we cannot continue simulation without DB record
        logger.error(`Failed to start simulated trade in database`, {
            symbol,
            entryPrice: entryPrice.toFixed(8),
            error: err.message,
            stack: err.stack?.slice(0, 300) // truncate long stacks
        });

        throw new Error(`Database error while starting simulation for ${symbol}: ${err.message}`);
    }
}

/**
 * Initializes and returns all mutable tracking variables needed for the main simulation loop.
 *
 * Purpose:
 *   - Create a single, clear "state object" that holds everything that changes during the 10-candle simulation.
 *   - Avoid scattering variables across the function scope (makes refactoring and debugging much easier).
 *   - Set safe, realistic initial values based on the incoming signal and entry price.
 *   - Prepare for scalping-specific behavior: no trailing stop, fixed SL only, position tracking for partial TPs.
 *
 * Why separate function?
 *   - Keeps simulateTrade() clean and readable (high-level flow only).
 *   - Easier to test this logic in isolation if needed.
 *   - Central place to adjust initial conditions (e.g. if you later want to simulate slippage or fees).
 *
 * Important initial values:
 *   - bestFavorablePrice / bestAdversePrice start at entryPrice → excursions begin from zero.
 *   - timeOfMax... also start at entry time (will be updated only when new extremes are reached).
 *   - remainingPosition = 1.0 → full position at start (partial TPs reduce it).
 *   - candleCount = 0 → we increment after each valid candle is processed.
 *
 * @param signal - The full TradeSignal containing direction, stopLoss, etc.
 * @param entryPrice - Exact entry price at signal generation time
 * @param startTime - Date.now() timestamp when simulation officially began
 * @returns Object with all loop-state variables (destructured or used directly in simulateTrade)
 */
function initializeTrackingVariables(
    signal: TradeSignal,
    entryPrice: number,
    startTime: number
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
    // 1. Direction flag – computed once, used everywhere for conditional logic
    const isLong = signal.signal === 'buy';

    // 2. Initial stop-loss
    //    - Use fixed stopLoss from signal (trailing is disabled in this scalping sim)
    //    - null if no SL configured (rare, but possible in some strategies)
    let currentStopLoss: number | null = null;
    if (signal.stopLoss !== undefined && signal.stopLoss > 0) {
        currentStopLoss = Number(signal.stopLoss.toFixed(8));

        // Optional sanity check: ensure SL is in the correct direction
        if (isLong && currentStopLoss >= entryPrice) {
            logger.warn(`Invalid long SL >= entry for ${signal.symbol} – ignoring SL`, {
                entry: entryPrice,
                sl: currentStopLoss
            });
            currentStopLoss = null;
        } else if (!isLong && currentStopLoss <= entryPrice) {
            logger.warn(`Invalid short SL <= entry for ${signal.symbol} – ignoring SL`, {
                entry: entryPrice,
                sl: currentStopLoss
            });
            currentStopLoss = null;
        }
    }

    // 3. Excursion tracking – start at entry price (zero excursion initially)
    //    bestFavorablePrice = direction-aware maximum favorable level seen
    //    bestAdversePrice  = direction-aware minimum adverse level seen
    const bestFavorablePrice = entryPrice;
    const bestAdversePrice = entryPrice;

    // 4. Timestamps of when the current max favorable / min adverse was reached
    //    Initially set to startTime – updated only when a new extreme occurs
    const timeOfMaxFavorable = startTime;
    const timeOfMaxAdverse = startTime;

    // 5. Position & PnL tracking
    //    - remainingPosition: fraction still open (1.0 → 0.0)
    //    - totalPnL: accumulated realized PnL from partial TPs (unrealized added at exit)
    const remainingPosition = 1.0;
    const totalPnL = 0.0;

    // 6. Candle counter – we allow exactly 10 processed candles
    //    Incremented only after a valid candle is fully handled
    const candleCount = 0;

    // Return immutable-style object (we mutate fields in the loop, but that's fine)
    return {
        isLong,
        currentStopLoss,
        bestFavorablePrice,
        bestAdversePrice,
        timeOfMaxFavorable,
        timeOfMaxAdverse,
        remainingPosition,
        totalPnL,
        candleCount
    };
}

/**
 * Pauses execution until the next candle period begins.
 *
 * Purpose in scalping simulation:
 *   - Ensures the simulation processes candles at realistic intervals matching the
 *     exchange's candle close times (e.g. every 60 seconds on 1m timeframe).
 *   - Prevents the loop from spinning too fast and consuming unnecessary CPU.
 *   - Simulates "real-time" behavior even when running in backtest-like mode.
 *
 * Why simple setTimeout-based sleep?
 *   - Most accurate for live simulation: we want to wait approximately pollIntervalMs
 *     after the previous candle was processed.
 *   - Keeps code lightweight — no complex candle boundary detection needed here
 *     (the exchangeService already provides the latest completed candle).
 *   - In production/live mode this naturally aligns with real market time.
 *
 * Trade-offs:
 *   - Not perfectly synced to exact candle close boundaries (slight drift possible over many candles)
 *   - For strict historical backtesting one might want candle-timestamp-based waiting,
 *     but for live scalping simulation this simple delay is sufficient and realistic.
 *
 * Tuning notes:
 *   - If you notice the simulation consistently processes candles too early/late,
 *     you can add a small offset (e.g. +200 ms) or switch to waiting until next
 *     candle timestamp > current processed timestamp.
 *   - pollIntervalMs comes from config.scanner.primaryTimeframe → should be 60000 for 1m.
 *
 * @param pollIntervalMs - Milliseconds per candle (e.g. 60000 for 1-minute candles)
 * @returns Promise that resolves after approximately pollIntervalMs
 */
async function waitForNextCandle(pollIntervalMs: number): Promise<void> {
    // ────────────────────────────────────────────────────────────────
    // Basic safety: prevent negative or zero intervals
    // ────────────────────────────────────────────────────────────────
    if (pollIntervalMs <= 0) {
        logger.warn(`Invalid poll interval ${pollIntervalMs} ms – using 1000 ms fallback`);
        await new Promise(resolve => setTimeout(resolve, 1000));
        return;
    }

    // ────────────────────────────────────────────────────────────────
    // Simple sleep using native Promise + setTimeout
    // This is the standard, reliable way in Node.js for async delays
    // ────────────────────────────────────────────────────────────────
    await new Promise<void>(resolve => {
        setTimeout(() => {
            resolve();
        }, pollIntervalMs);
    });

    // Optional: very light debug logging (disabled by default in production)
    // Uncomment if you want to see timing in dev:
    /*
    if (logger.isDebugEnabled()) {
        logger.debug(`Waited for next candle`, {
            intervalMs: pollIntervalMs,
            actualDelayMs: Date.now() - previousTime // you could track previousTime if needed
        });
    }
    */
}

/**
 * Safely retrieves the high and low prices from the most recent completed candle
 * for the given symbol from the exchange service's cached OHLCV data.
 *
 * Purpose in scalping simulation:
 *   - We need the latest **completed** candle's high/low to:
 *     - Update MFE (max favorable excursion) using the high (long) or low (short)
 *     - Update MAE (max adverse excursion) using the low (long) or high (short)
 *     - Check if TP/SL levels were hit during this candle
 *   - This function acts as a clean, defensive interface between the simulation loop
 *     and the ExchangeService's internal OHLCV cache.
 *
 * Why defensive / safe approach?
 *   - ExchangeService.getPrimaryOhlcvData() may return:
 *     - empty array (no data yet)
 *     - incomplete candle (current forming candle)
 *     - corrupted values (NaN, null, negative prices, etc.)
 *   - We **never** want to use invalid candle data → it would corrupt MFE/MAE and PnL
 *   - Returning null lets the loop skip the candle safely instead of crashing
 *
 * Return format:
 *   - { high: number, low: number }  → valid, usable candle
 *   - null                          → no usable candle yet → loop should wait/skip
 *
 * @param exchangeService - The live data provider (has cached OHLCV arrays)
 * @param symbol - Trading pair (e.g. 'BTC/USDT')
 * @returns Latest completed candle's high/low or null if unavailable/invalid
 */
function getCurrentCandle(
    exchangeService: ExchangeService,
    symbol: string
): { high: number; low: number } | null {
    // ────────────────────────────────────────────────────────────────
    // 1. Fetch the full OHLCV array from the exchange service cache
    //    getPrimaryOhlcvData() should return number[][] where each row is:
    //    [timestamp, open, high, low, close, volume]
    // ────────────────────────────────────────────────────────────────
    const rawData = exchangeService.getPrimaryOhlcvData(symbol);

    // ────────────────────────────────────────────────────────────────
    // 2. Basic existence & length checks
    //    We need at least 2 candles to safely use the latest one
    //    (1 candle might be the forming one, not completed)
    // ────────────────────────────────────────────────────────────────
    if (!rawData || !Array.isArray(rawData) || rawData.length < 2) {
        // No data or too little data → nothing usable yet
        return null;
    }

    // ────────────────────────────────────────────────────────────────
    // 3. Take the LAST candle (most recent completed one)
    // ────────────────────────────────────────────────────────────────
    const latestCandle = rawData[rawData.length - 1];

    // ────────────────────────────────────────────────────────────────
    // 4. Extract high and low – be extremely defensive
    // ────────────────────────────────────────────────────────────────
    const high = Number(latestCandle[2]);  // index 2 = high
    const low = Number(latestCandle[3]);  // index 3 = low

    // ────────────────────────────────────────────────────────────────
    // 5. Validate extracted values before returning
    //    Reject if:
    //    - NaN / Infinity
    //    - zero or negative (invalid for price)
    //    - high < low (impossible)
    // ────────────────────────────────────────────────────────────────
    if (
        isNaN(high) || isNaN(low) ||
        high <= 0 || low <= 0 ||
        low > high
    ) {
        logger.warn(`Invalid candle values received for ${symbol}`, {
            high: latestCandle[2],
            low: latestCandle[3],
            timestamp: latestCandle[0]
        });
        return null;
    }

    // ────────────────────────────────────────────────────────────────
    // 6. Optional: extra sanity check against absurd price moves
    //    (e.g. 100x pump/dump in one candle – likely exchange glitch)
    //    You can tune or remove this threshold later
    // ────────────────────────────────────────────────────────────────
    const previousCandle = rawData[rawData.length - 2];
    const prevClose = Number(previousCandle[4]); // close of previous candle

    if (
        !isNaN(prevClose) && prevClose > 0 &&
        (high > prevClose * 20 || low < prevClose / 20) // 20× move = very suspicious
    ) {
        logger.warn(`Extreme candle detected – skipping`, {
            symbol,
            high,
            low,
            prevClose,
            ratioHigh: (high / prevClose).toFixed(2),
            ratioLow: (low / prevClose).toFixed(2)
        });
        return null;
    }

    // ────────────────────────────────────────────────────────────────
    // 7. All checks passed → return clean, usable high/low
    // ────────────────────────────────────────────────────────────────
    return { high, low };
}

/**
 * Validates whether a candle's high/low values are usable for the simulation.
 *
 * Purpose:
 *   - Protect the simulation from corrupted, unrealistic or glitchy candle data
 *     coming from the exchange (common in live crypto feeds: NaN, zero prices,
 *     extreme spikes, inverted high/low, etc.).
 *   - Prevent bad data from corrupting:
 *     - MFE / MAE calculations
 *     - TP/SL hit detection
 *     - Final PnL and label
 *     - Excursion history cache
 *
 * Return value:
 *   - true  → candle is safe to use → proceed with excursion updates & exit checks
 *   - false → skip this candle entirely → wait for next one
 *
 * Why so defensive?
 *   - In live trading simulation, one bad candle can ruin an entire simulation's
 *     statistics (especially MFE/MAE which accumulate over candles).
 *   - Better to skip a candle (minor delay) than to use invalid data.
 *
 * Validation rules (ordered roughly by severity / frequency):
 *   1. Basic NaN / Infinity / non-number checks
 *   2. Zero or negative prices (impossible in real markets)
 *   3. High < low (data inversion – exchange bug)
 *   4. Extreme deviation from entry price (absurd pump/dump in one candle)
 *
 * @param high - High price of the candle
 * @param low  - Low price of the candle
 * @param entryPrice - Original entry price of the simulated trade
 *                     (used as reference to detect extreme moves)
 * @returns boolean – true = valid & usable, false = skip this candle
 */
function validateCandle(
    high: number,
    low: number,
    entryPrice: number
): boolean {
    // ────────────────────────────────────────────────────────────────
    // 1. Fundamental type & numeric sanity checks
    //    Reject anything that isn't a real, finite number
    // ────────────────────────────────────────────────────────────────
    if (
        typeof high !== 'number' || typeof low !== 'number' ||
        isNaN(high) || isNaN(low) ||
        !isFinite(high) || !isFinite(low)
    ) {
        // Very common when exchange returns null/undefined in array
        logger.debug(`Candle rejected: non-numeric or NaN values`, { high, low });
        return false;
    }

    // ────────────────────────────────────────────────────────────────
    // 2. Zero or negative prices – physically impossible
    // ────────────────────────────────────────────────────────────────
    if (high <= 0 || low <= 0) {
        logger.warn(`Candle rejected: zero or negative price`, { high, low, entryPrice });
        return false;
    }

    // ────────────────────────────────────────────────────────────────
    // 3. High must be >= low – basic OHLC integrity
    // ────────────────────────────────────────────────────────────────
    if (low > high) {
        logger.warn(`Candle rejected: inverted high/low (low > high)`, {
            high,
            low,
            entryPrice
        });
        return false;
    }

    // ────────────────────────────────────────────────────────────────
    // 4. Extreme deviation from entry price
    //    Protects against single-candle 100x pumps/dumps (exchange errors,
    //    bad websocket data, testnet glitches, etc.)
    //
    // Threshold choices:
    //   • 10× → very conservative (most real 1m candles rarely > 5–7%)
    //   • You can lower to 3–5× if your symbols are stable
    //   • Or raise to 20–50× if you're trading very volatile pairs
    // ────────────────────────────────────────────────────────────────
    const MAX_PRICE_MULTIPLIER = 10; // adjustable constant

    if (
        high > entryPrice * MAX_PRICE_MULTIPLIER ||
        low < entryPrice / MAX_PRICE_MULTIPLIER
    ) {
        const highRatio = (high / entryPrice).toFixed(2);
        const lowRatio = (low / entryPrice).toFixed(2);

        logger.warn(`Candle rejected: extreme price deviation from entry`, {
            high,
            low,
            entryPrice,
            highRatio: `×${highRatio}`,
            lowRatio: `×${lowRatio}`,
            maxAllowed: `×${MAX_PRICE_MULTIPLIER}`
        });

        return false;
    }

    // ────────────────────────────────────────────────────────────────
    // 5. All checks passed → candle is usable
    // ────────────────────────────────────────────────────────────────
    return true;
}

/**
 * Updates the running maximum favorable and minimum adverse price levels
 * based on the current candle's high and low, and records the time **only**
 * when a new extreme is actually reached.
 *
 * Rules:
 *   - Timestamp is updated **only** when a strictly better extreme is found
 *   - For LONG: favorable = higher price (use high), adverse = lower price (use low)
 *   - For SHORT: favorable = lower price (use low), adverse = higher price (use high)
 *   - Initial values should be entry price and entry time
 *   - Returns new values — does not mutate inputs
 *
 * @param isLong - true for buy/long, false for sell/short
 * @param high - high price of current candle
 * @param low - low price of current candle
 * @param bestFavorablePrice - current best favorable price so far
 * @param bestAdversePrice - current worst adverse price so far
 * @param currentTime - timestamp of this candle's close (or Date.now())
 * @param prevTimeFavorable - previous time of max favorable (entry time initially)
 * @param prevTimeAdverse - previous time of max adverse (entry time initially)
 * @returns updated prices and **unchanged** timestamps unless a new extreme was hit
 */
function updateExcursionExtremes(
    isLong: boolean,
    high: number,
    low: number,
    bestFavorablePrice: number,
    bestAdversePrice: number,
    currentTime: number,
    prevTimeFavorable: number,
    prevTimeAdverse: number
): {
    newBestFavorable: number;
    newBestAdverse: number;
    newTimeOfMaxFavorable: number;
    newTimeOfMaxAdverse: number;
} {
    // Preserve the incoming values — only change when a new extreme is hit
    let newBestFavorable = bestFavorablePrice;
    let newBestAdverse = bestAdversePrice;
    let newTimeFavorable = prevTimeFavorable;  // ← start with previous time
    let newTimeAdverse = prevTimeAdverse;    // ← start with previous time

    // Safety: skip update if candle data is invalid
    if (isNaN(high) || isNaN(low) || high <= 0 || low <= 0 || low > high) {
        logger.warn('Invalid candle extremes – skipping excursion update', {
            high,
            low,
            currentBestFavorable: bestFavorablePrice.toFixed(8),
            currentBestAdverse: bestAdversePrice.toFixed(8)
        });
        return {
            newBestFavorable,
            newBestAdverse,
            newTimeOfMaxFavorable: newTimeFavorable,
            newTimeOfMaxAdverse: newTimeAdverse
        };
    }

    if (isLong) {
        // LONG: higher = better (favorable), lower = worse (adverse)
        if (high > bestFavorablePrice) {
            newBestFavorable = high;
            newTimeFavorable = currentTime;  // ← only here we update time
        }

        if (low < bestAdversePrice) {
            newBestAdverse = low;
            newTimeAdverse = currentTime;    // ← only here we update time
        }
    } else {
        // SHORT: lower = better (favorable), higher = worse (adverse)
        if (low < bestFavorablePrice) {
            newBestFavorable = low;
            newTimeFavorable = currentTime;
        }

        if (high > bestAdversePrice) {
            newBestAdverse = high;
            newTimeAdverse = currentTime;
        }
    }

    return {
        newBestFavorable,
        newBestAdverse,
        newTimeOfMaxFavorable: newTimeFavorable,
        newTimeOfMaxAdverse: newTimeAdverse
    };
}

/**
 * Checks whether any partial take-profit levels were hit during the current candle
 * and calculates the realized PnL from any closed portions.
 *
 * How partial TPs work in this scalping simulation:
 *   - signal.takeProfitLevels is an array of { price: number, weight: number }
 *     where weight is the fraction of the position to close at that level (sums ≤ 1.0)
 *   - Levels should be sorted: for longs → increasing price, for shorts → decreasing price
 *   - We check from the most aggressive (closest) level first
 *   - Multiple levels can be hit in the same candle (e.g. strong move)
 *   - We only close what remains of the position (no over-closing)
 *
 * Return value:
 *   - null                  → no partial TP hit in this candle
 *   - { hit: true, newRemaining, newTotalPnL } → at least one level was hit,
 *                                                 returns updated position & realized PnL
 *
 * Important behaviors:
 *   - Uses candle high/low to determine if price reached the TP level
 *     (conservative: for long, we need high ≥ TP price; for short, low ≤ TP price)
 *   - Accumulates PnL only for the closed portion
 *   - Does **not** close the full position here (that's for single TP or timeout/SL)
 *   - Safe against floating-point precision issues (uses small epsilon for comparisons)
 *
 * @param signal - Full TradeSignal containing takeProfitLevels array
 * @param isLong - true for buy/long trades
 * @param high - high price of current candle
 * @param low - low price of current candle
 * @param entryPrice - original entry price
 * @param remainingPosition - current open position fraction (1.0 → 0.0)
 * @param totalPnL - already realized PnL from previous partials
 * @returns null if no hit, or object with updated remaining position and total realized PnL
 */
function checkPartialTakeProfits(
    signal: TradeSignal,
    isLong: boolean,
    high: number,
    low: number,
    entryPrice: number,
    remainingPosition: number,
    totalPnL: number
): { hit: boolean; newRemaining: number; newTotalPnL: number } | null {
    // ────────────────────────────────────────────────────────────────
    // 1. Early exit: no partial levels configured or position already closed
    // ────────────────────────────────────────────────────────────────
    if (
        !signal.takeProfitLevels ||
        signal.takeProfitLevels.length === 0 ||
        remainingPosition <= 0.01
    ) {
        return null;
    }

    // ────────────────────────────────────────────────────────────────
    // 2. Sort levels by aggressiveness (closest first)
    //    - Longs: lowest price first
    //    - Shorts: highest price first
    //    We sort a copy so we don't mutate the original signal
    // ────────────────────────────────────────────────────────────────
    const sortedLevels = [...signal.takeProfitLevels].sort((a, b) =>
        isLong ? a.price - b.price : b.price - a.price
    );

    let newRemaining = remainingPosition;
    let newTotalPnL = totalPnL;
    let anyHit = false;

    // Small epsilon to handle floating-point precision
    const EPSILON = 1e-8;

    // ────────────────────────────────────────────────────────────────
    // 3. Check each level in order (can hit multiple in one candle)
    // ────────────────────────────────────────────────────────────────
    for (const level of sortedLevels) {
        // Skip if we don't have enough position left for this level
        if (newRemaining < level.weight - EPSILON) {
            continue;
        }

        // Determine if this level was reached in the current candle
        const tpHit = isLong
            ? high >= level.price - EPSILON
            : low <= level.price + EPSILON;

        if (tpHit) {
            // ── Calculate PnL for this partial close ───────────────────
            const pnlThisLevel = isLong
                ? (level.price - entryPrice) / entryPrice
                : (entryPrice - level.price) / entryPrice;

            // Add realized PnL from this portion
            newTotalPnL += pnlThisLevel * level.weight;

            // Reduce remaining position
            newRemaining -= level.weight;

            anyHit = true;

            // Optional debug log (uncomment in dev if needed)
            /*
            logger.debug(`Partial TP hit at level ${level.price.toFixed(8)}`, {
                weight: level.weight,
                pnlThis: (pnlThisLevel * 100).toFixed(2) + '%',
                remainingAfter: newRemaining.toFixed(4)
            });
            */

            // Continue checking next levels (possible to hit multiple)
        }
    }

    // ────────────────────────────────────────────────────────────────
    // 4. Return result only if something was actually closed
    // ────────────────────────────────────────────────────────────────
    if (anyHit) {
        // Clamp remaining to avoid tiny floating-point leftovers
        newRemaining = Math.max(0, newRemaining);

        return {
            hit: true,
            newRemaining,
            newTotalPnL
        };
    }

    // No partials hit
    return null;
}

/**
 * Checks whether the single full-position take-profit level (signal.takeProfit)
 * was hit during the current candle.
 *
 * This function handles the **classic single take-profit** case:
 *   - If signal.takeProfit is set → close 100% of the position when price reaches it
 *   - Different from partial take-profits (which are handled separately in checkPartialTakeProfits)
 *
 * Hit detection logic:
 *   - For LONG trades: hit if candle high >= takeProfit price
 *   - For SHORT trades: hit if candle low <= takeProfit price
 *
 * Why conservative detection?
 *   - We use the candle's extreme (high/low) to determine if the level was touched
 *     at any point during the candle — this is realistic for 1-minute scalping
 *     where we don't have tick-level data.
 *   - Prevents missing hits due to intra-candle wicks.
 *
 * Return value:
 *   - true  → take-profit level was reached → simulation should exit with full TP
 *   - false → not hit yet → continue simulation
 *
 * Edge cases handled:
 *   - No takeProfit configured → always returns false
 *   - Invalid takeProfit price (≤0) → safely ignored
 *   - Floating-point precision → small epsilon used
 *
 * @param signal - Full TradeSignal containing the optional single takeProfit price
 * @param isLong - true for buy/long, false for sell/short
 * @param high - high price of the current candle
 * @param low - low price of the current candle
 * @returns boolean – true if full take-profit was hit in this candle
 */
function checkFullTakeProfit(
    signal: TradeSignal,
    isLong: boolean,
    high: number,
    low: number
): boolean {
    // ────────────────────────────────────────────────────────────────
    // 1. Early exit: no single take-profit configured
    // ────────────────────────────────────────────────────────────────
    if (
        signal.takeProfit === undefined ||
        signal.takeProfit <= 0 ||
        isNaN(signal.takeProfit)
    ) {
        return false;
    }

    // ────────────────────────────────────────────────────────────────
    // 2. Small epsilon for floating-point safety
    //    Prevents missing hits due to rounding errors
    //    (e.g. high = 100.0000001, takeProfit = 100)
    // ────────────────────────────────────────────────────────────────
    const EPSILON = 1e-8;

    // ────────────────────────────────────────────────────────────────
    // 3. Direction-aware hit condition
    //    LONG: need high enough to reach TP
    //    SHORT: need low enough to reach TP
    // ────────────────────────────────────────────────────────────────
    const tpHit = isLong
        ? high >= signal.takeProfit - EPSILON
        : low <= signal.takeProfit + EPSILON;

    // Optional: debug logging (uncomment during development if needed)
    /*
    if (tpHit && logger.isDebugEnabled()) {
        logger.debug(`Full TP hit detected`, {
            direction: isLong ? 'LONG' : 'SHORT',
            takeProfit: signal.takeProfit.toFixed(8),
            candleHigh: high.toFixed(8),
            candleLow: low.toFixed(8)
        });
    }
    */

    return tpHit;
}

/**
 * Checks whether the stop-loss level (fixed only – no trailing in this scalping sim)
 * was hit during the current candle.
 *
 * How stop-loss hit is determined:
 *   - For LONG trades (isLong = true):
 *     - Hit if candle low ≤ currentStopLoss
 *     - This means price dipped low enough to trigger the stop
 *   - For SHORT trades (isLong = false):
 *     - Hit if candle high ≥ currentStopLoss
 *     - This means price spiked high enough to trigger the stop
 *
 * Why use candle extremes (low/high)?
 *   - In 1-minute scalping simulation, we don't have tick-level data.
 *   - Using low/high assumes the wick could have touched the SL even if close didn't.
 *   - This is conservative and realistic: better to exit early than miss a real hit.
 *
 * Return value:
 *   - true  → stop-loss was triggered → simulation should exit with SL outcome
 *   - false → not hit yet → continue checking other exits or next candle
 *
 * Edge cases handled:
 *   - No stop-loss configured (currentStopLoss = null) → always returns false
 *   - Invalid stop-loss price (≤0 or NaN) → treated as no SL
 *   - Floating-point precision → small epsilon used in comparison
 *
 * @param isLong - true for buy/long trades
 * @param low - low price of the current candle
 * @param high - high price of the current candle
 * @param currentStopLoss - current active stop-loss price (null if none)
 * @returns boolean – true if stop-loss was hit in this candle
 */
function checkStopLoss(
    isLong: boolean,
    low: number,
    high: number,
    currentStopLoss: number | null
): boolean {
    // ────────────────────────────────────────────────────────────────
    // 1. Early exit: no stop-loss configured
    // ────────────────────────────────────────────────────────────────
    if (currentStopLoss === null || currentStopLoss <= 0 || isNaN(currentStopLoss)) {
        return false;
    }

    // ────────────────────────────────────────────────────────────────
    // 2. Small epsilon for floating-point safety
    //    Prevents missing hits due to tiny rounding differences
    //    (e.g. low = 99.999999, SL = 100)
    // ────────────────────────────────────────────────────────────────
    const EPSILON = 1e-8;

    // ────────────────────────────────────────────────────────────────
    // 3. Direction-aware hit condition
    //    LONG: low price must reach or go below SL
    //    SHORT: high price must reach or go above SL
    // ────────────────────────────────────────────────────────────────
    const slHit = isLong
        ? low <= currentStopLoss + EPSILON
        : high >= currentStopLoss - EPSILON;

    // Optional: debug logging (uncomment during development/testing)
    /*
    if (slHit && logger.isDebugEnabled()) {
        logger.debug(`Stop-loss hit detected`, {
            direction: isLong ? 'LONG' : 'SHORT',
            stopLoss: currentStopLoss.toFixed(8),
            candleLow: low.toFixed(8),
            candleHigh: high.toFixed(8)
        });
    }
    */

    return slHit;
}

/**
 * FINAL FINALIZER – called by all exit points in the simulation
 *
 * This is the SINGLE place where we:
 *   - Finalize all calculations (excursions, duration, times, R-multiple, label)
 *   - Apply safety bounds & fallbacks
 *   - Update the excursion cache (critical for regime advice)
 *   - Close the DB simulation record
 *   - Log a consistent, structured summary
 *   - Return the complete SimulationResult object
 *
 * @param outcome - Final outcome type ('tp', 'partial_tp', 'sl', 'timeout')
 *                  Must be passed correctly by the caller based on exit condition
 * @param signalId - DB unique ID for this simulation
 * @param startTime - Timestamp when simulation began
 * @param totalPnL - Final realized + unrealized PnL at exit
 * @param entryPrice - Original entry price
 * @param isLong - true = long/buy trade
 * @param bestFavorablePrice - Best favorable price reached
 * @param bestAdversePrice - Worst adverse price reached
 * @param timeOfMaxFavorable - When best favorable was reached
 * @param timeOfMaxAdverse - When worst adverse was reached
 * @param symbol - Trading pair
 * @returns Complete SimulationResult object
 */
async function finalizeSimulation(
    outcome: 'tp' | 'partial_tp' | 'sl' | 'timeout',
    signalId: string,
    startTime: number,
    totalPnL: number,
    entryPrice: number,
    isLong: boolean,
    bestFavorablePrice: number,
    bestAdversePrice: number,
    timeOfMaxFavorable: number,
    timeOfMaxAdverse: number,
    symbol: string
): Promise<SimulationResult> {
    // ────────────────────────────────────────────────────────────────
    // 1. Calculate final duration (wall-clock ms from entry to exit)
    // ────────────────────────────────────────────────────────────────
    const endTime = Date.now();
    const duration_ms = endTime - startTime;

    // ────────────────────────────────────────────────────────────────
    // 2. Compute excursions as percentages (MFE ≥ 0, MAE ≤ 0)
    // ────────────────────────────────────────────────────────────────
    const rawMfeDelta = isLong
        ? bestFavorablePrice - entryPrice
        : entryPrice - bestFavorablePrice;

    const finalMfePct = (rawMfeDelta / entryPrice) * 100;

    const rawMaeDelta = isLong
        ? entryPrice - bestAdversePrice
        : bestAdversePrice - entryPrice;

    const finalMaePctRaw = (rawMaeDelta / entryPrice) * 100;
    const finalMaePct = -Math.abs(finalMaePctRaw); // convention: MAE negative or zero

    // Bound extremes to prevent outliers from corrupting regime stats
    const MAX_MFE_CAP = 1000;
    const MAX_MAE_FLOOR = -1000;
    const boundedMfePct = Math.max(0, Math.min(MAX_MFE_CAP, finalMfePct));
    const boundedMaePct = Math.max(MAX_MAE_FLOOR, Math.min(0, finalMaePct));

    // ────────────────────────────────────────────────────────────────
    // 3. Time-to-extremes (how long it took to reach best/worst points)
    // ────────────────────────────────────────────────────────────────
    const timeToMaxMFE_ms = timeOfMaxFavorable - startTime;
    const timeToMaxMAE_ms = timeOfMaxAdverse - startTime;

    // Safety: clamp times (should never be negative)
    const clampedTimeMFE = Math.max(0, timeToMaxMFE_ms);
    const clampedTimeMAE = Math.max(0, timeToMaxMAE_ms);

    // ────────────────────────────────────────────────────────────────
    // 4. R-multiple & ML label
    // ────────────────────────────────────────────────────────────────
    const FALLBACK_RISK_PCT = 0.015;
    const rMultiple = totalPnL / FALLBACK_RISK_PCT;
    const label = computeLabel(rMultiple);

    // ────────────────────────────────────────────────────────────────
    // 5. Update excursion cache
    // ────────────────────────────────────────────────────────────────
    excursionCache.updateOrAdd(symbol, signalId, {
        outcome,
        rMultiple,
        label,
        durationMs: duration_ms,
        mfe: boundedMfePct,
        mae: boundedMaePct,
        timeToMFE_ms: clampedTimeMFE,
        timeToMAE_ms: clampedTimeMAE,
        direction: isLong ? 'buy' : 'sell',
        timestamp: endTime,
    });

    // ────────────────────────────────────────────────────────────────
    // 6. Close the simulation record in database
    // ────────────────────────────────────────────────────────────────
    await dbService.closeSimulatedTrade(
        signalId,
        outcome,
        totalPnL,
        rMultiple,
        label,
        bestFavorablePrice,
        bestAdversePrice,
        timeOfMaxFavorable,
        timeOfMaxAdverse,
        duration_ms
    );

    // ────────────────────────────────────────────────────────────────
    // 7. Consistent structured logging across all outcomes
    // ────────────────────────────────────────────────────────────────
    logger.info(`[SIM] ${symbol} FINALIZED – ${outcome.toUpperCase()}`, {
        signalId,
        side: isLong ? 'LONG' : 'SHORT',
        outcome,
        pnlPct: (totalPnL * 100).toFixed(2) + '%',
        rMultiple: rMultiple.toFixed(3),
        label,
        durationMin: (duration_ms / 60000).toFixed(2),
        mfePct: boundedMfePct.toFixed(2),
        maePct: boundedMaePct.toFixed(2),
        timeToMFE: (clampedTimeMFE / 1000).toFixed(1) + 's',
        timeToMAE: (clampedTimeMAE / 1000).toFixed(1) + 's',
        start: new Date(startTime).toISOString(),
        end: new Date(endTime).toISOString()
    });

    // ────────────────────────────────────────────────────────────────
    // 8. Return clean result object for caller
    // ────────────────────────────────────────────────────────────────
    return {
        outcome,
        pnl: totalPnL,
        pnlPercent: totalPnL * 100,
        rMultiple,
        label,
        maxFavorableExcursion: boundedMfePct,
        maxAdverseExcursion: boundedMaePct,
        duration_ms,
        timeToMaxMFE_ms: clampedTimeMFE,
        timeToMaxMAE_ms: clampedTimeMAE
    };
}

/**
 * Determines the exit price to use when forcing a timeout exit after exactly 10 candles.
 *
 * Purpose in scalping simulation:
 *   - On timeout, we need a realistic "forced close" price at the end of the 10th candle.
 *   - This price is used to calculate the final unrealized PnL for the remaining position.
 *   - Goal: be conservative/fair — avoid overly optimistic or pessimistic assumptions.
 *
 * Chosen logic (conservative for scalping):
 *   - LONG trades: use the **low** of the last candle
 *     → assumes worst-case exit (price could have dropped to low before close)
 *   - SHORT trades: use the **high** of the last candle
 *     → assumes worst-case exit (price could have spiked to high before close)
 *
 * Why conservative (low for long, high for short)?
 *   - Prevents inflating PnL on timeouts (common in optimistic sims)
 *   - Better reflects real trading risk: you might not get the close price if slippage or gap
 *   - Aligns with "adverse" mindset for timeout (trade didn't hit target → penalize a bit)
 *
 * Alternatives you can switch to later:
 *   - Use close price → more neutral/realistic if you trust candle close
 *   - Use (high + low)/2 → midpoint compromise
 *   - Use open price of 11th candle (if available) → but complicates data fetch
 *
 * Safety:
 *   - Falls back to entryPrice if inputs invalid (prevents NaN/crash)
 *   - Logs warning if fallback triggered (helps debug bad candle data)
 *
 * @param isLong - true = long/buy trade
 * @param lastCandleHigh - high price of the final (10th) candle
 * @param lastCandleLow - low price of the final (10th) candle
 * @param entryPrice - original entry price (fallback only)
 * @returns Exit price to use for PnL calculation on timeout
 */
function calculateExitPriceForTimeout(
    isLong: boolean,
    lastCandleHigh: number,
    lastCandleLow: number,
    entryPrice: number
): number {
    // ────────────────────────────────────────────────────────────────
    // 1. Basic input validation
    //    Protect against NaN, invalid, or missing candle data
    // ────────────────────────────────────────────────────────────────
    if (
        isNaN(lastCandleHigh) || isNaN(lastCandleLow) ||
        lastCandleHigh <= 0 || lastCandleLow <= 0 ||
        lastCandleLow > lastCandleHigh
    ) {
        logger.warn(`Invalid last candle data for timeout exit – falling back to entry price`, {
            high: lastCandleHigh,
            low: lastCandleLow,
            entryPrice
        });
        return entryPrice;
    }

    // ────────────────────────────────────────────────────────────────
    // 2. Conservative exit price selection
    //    LONG: use low (worst-case exit)
    //    SHORT: use high (worst-case exit)
    // ────────────────────────────────────────────────────────────────
    const exitPrice = isLong ? lastCandleLow : lastCandleHigh;

    // Optional debug log (uncomment during testing)
    /*
    if (logger.isDebugEnabled()) {
        logger.debug(`Timeout exit price selected`, {
            direction: isLong ? 'LONG' : 'SHORT',
            exitPrice: exitPrice.toFixed(8),
            candleHigh: lastCandleHigh.toFixed(8),
            candleLow: lastCandleLow.toFixed(8),
            entryPrice: entryPrice.toFixed(8)
        });
    }
    */

    return exitPrice;
}

/**
 * Maps the achieved R-multiple (PnL relative to initial risk) to one of five discrete ML labels.
 *
 * Purpose:
 *   - Convert continuous R-multiple into a simple, categorical target for machine learning training
 *   - Labels range from -2 (strong loss) to +2 (strong win), with 0 as neutral/breakeven
 *   - Used consistently across all simulations (TP, SL, partial TP, timeout)
 *   - Becomes the ground-truth label for training models to predict trade quality
 *
 * Thresholds (current fixed values – 2025 scalping version):
 *   ≥ +3.0 R → +2 (excellent win – strong conviction)
 *   ≥ +1.5 R → +1 (solid win – good but not exceptional)
 *   ≥ -0.5 R → 0  (breakeven / small scratch – neutral)
 *   ≥ -1.5 R → -1 (small loss – acceptable drawdown)
 *   <  -1.5 R → -2 (large loss – disaster / stop hunting / bad regime)
 *
 * Why these thresholds?
 *   - Asymmetric: wins need higher R to be "great" (scalping favors quick +1.5–3R wins)
 *   - Losses are penalized more harshly below -1.5R (protects capital in live trading)
 *   - Neutral zone (-0.5 to +1.5) is wide — avoids over-penalizing small winners or scratch trades
 *
 * Configurability notes:
 *   - Currently hardcoded – in future, pull from config.strategy.labelThresholds
 *   - You can make it stricter (e.g. +4R for +2) or more lenient (e.g. +1R for +2)
 *   - Keep symmetry or asymmetry depending on your risk/reward philosophy
 *
 * @param rMultiple - Risk-adjusted return (PnL / initial risk percentage)
 * @returns ML label: -2 | -1 | 0 | 1 | 2
 */
export function computeLabel(rMultiple: number): -2 | -1 | 0 | 1 | 2 {
    // ────────────────────────────────────────────────────────────────
    // Core threshold ladder – ordered from best to worst
    // ────────────────────────────────────────────────────────────────
    if (rMultiple >= 3.0) {
        return 2;   // Strong win – high confidence signal
    }

    if (rMultiple >= 1.5) {
        return 1;   // Good win – respectable outcome
    }

    if (rMultiple >= -0.5) {
        return 0;   // Neutral / breakeven – no strong edge or loss
    }

    if (rMultiple >= -1.5) {
        return -1;  // Small loss – acceptable in most regimes
    }

    // ────────────────────────────────────────────────────────────────
    // Default: anything worse than -1.5R is a strong negative label
    // ────────────────────────────────────────────────────────────────
    return -2;      // Major loss – regime warning, reversal candidate
}
