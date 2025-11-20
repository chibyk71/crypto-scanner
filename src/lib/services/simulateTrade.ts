// src/lib/services/simulateTrade.ts
import { ExchangeService } from './exchange';
import { dbService } from '../db';
import type { TradeSignal } from '../strategy';
import { createLogger } from '../logger';

const logger = createLogger('simulateTrade');

/**
 * Simulates a trade from entry to exit using live primary OHLCV polling.
 * - Monitors price every 15 seconds
 * - Supports SL, TP, and trailing stop
 * - Checks **high/low** of the newest candle to catch intra-candle hits
 * - Logs outcome to `simulated_trades` table
 * - Returns { outcome: 'tp' | 'sl' | 'timeout', pnl }
 */
export async function simulateTrade(
    exchangeService: ExchangeService,
    symbol: string,
    signal: TradeSignal,
    entryPrice: number
): Promise<{ outcome: 'tp' | 'sl' | 'timeout'; pnl: number }> {
    const signalId = await dbService.startSimulatedTrade({
        symbol,
        side: signal.signal,
        entryPrice: Math.round(entryPrice * 1e8), // 8 decimals
        stopLoss: signal.stopLoss ? Math.round(signal.stopLoss * 1e8) : null,
        takeProfit: signal.takeProfit ? Math.round(signal.takeProfit * 1e8) : null,
        trailingDist: signal.trailingStopDistance ? Math.round(signal.trailingStopDistance * 1e8) : null,
    });

    const isLong = signal.signal === 'buy';
    let currentStop = signal.stopLoss;
    let highestPrice = entryPrice; // for trailing stop (long)
    let lowestPrice = entryPrice;  // for trailing stop (short)
    const timeoutMs = 60 * 60 * 1000; // 1 hour max
    const startTime = Date.now();
    const pollIntervalMs = 180_000; // 3m

    logger.info(`Simulating ${signal.signal} trade`, {
        symbol,
        entryPrice,
        stopLoss: currentStop,
        takeProfit: signal.takeProfit,
        signalId,
    });

    while (Date.now() - startTime < timeoutMs) {
        try {
            const raw = exchangeService.getPrimaryOhlcvData(symbol);
            if (!raw || raw.length === 0) {
                await new Promise(r => setTimeout(r, pollIntervalMs));
                continue;
            }

            const latest = raw[raw.length - 1];
            const closePrice = Number(latest[4]);   // close
            const highPrice  = Number(latest[2]);   // high
            const lowPrice   = Number(latest[3]);   // low

            // ---- 1. Update trailing stop using the **close** (keeps it responsive) ----
            if (signal.trailingStopDistance) {
                if (isLong && closePrice > highestPrice) {
                    highestPrice = closePrice;
                    const newStop = highestPrice - signal.trailingStopDistance;
                    if (!currentStop || newStop > currentStop) {
                        currentStop = newStop;
                    }
                } else if (!isLong && closePrice < lowestPrice) {
                    lowestPrice = closePrice;
                    const newStop = lowestPrice + signal.trailingStopDistance;
                    if (!currentStop || newStop < currentStop) {
                        currentStop = newStop;
                    }
                }
            }

            // ---- 2. Determine the price we would have exited at in this candle ----
            const exitPriceForCandle = isLong ? highPrice : lowPrice;

            // ---- 3. Check TP ----------------------------------------------------
            if (signal.takeProfit) {
                const tpHit = isLong
                    ? exitPriceForCandle >= signal.takeProfit
                    : exitPriceForCandle <= signal.takeProfit;

                if (tpHit) {
                    const pnl = isLong
                        ? (signal.takeProfit - entryPrice) / entryPrice
                        : (entryPrice - signal.takeProfit) / entryPrice;
                    await dbService.closeSimulatedTrade(signalId, 'tp', Math.round(pnl * 1e8));
                    logger.info(`Simulated trade HIT TP (candle high/low)`, {
                        symbol,
                        pnl: pnl.toFixed(6),
                        signalId,
                        exitPrice: signal.takeProfit,
                    });
                    return { outcome: 'tp', pnl };
                }
            }

            // ---- 4. Check SL (including trailing) --------------------------------
            if (currentStop) {
                const slHit = isLong
                    ? exitPriceForCandle <= currentStop
                    : exitPriceForCandle >= currentStop;

                if (slHit) {
                    const pnl = isLong
                        ? (currentStop - entryPrice) / entryPrice
                        : (entryPrice - currentStop) / entryPrice;
                    await dbService.closeSimulatedTrade(signalId, 'sl', Math.round(pnl * 1e8));
                    logger.info(`Simulated trade HIT SL (candle high/low)`, {
                        symbol,
                        pnl: pnl.toFixed(6),
                        signalId,
                        exitPrice: currentStop,
                    });
                    return { outcome: 'sl', pnl };
                }
            }

            // ---- 5. No hit – wait for next poll ---------------------------------
            await new Promise(r => setTimeout(r, pollIntervalMs));
        } catch (err) {
            logger.error(`Error in simulateTrade loop for ${symbol}`, { error: err });
            await new Promise(r => setTimeout(r, pollIntervalMs));
        }
    }

    // ---- Timeout: close at the last available close price --------------------
    const finalRaw = exchangeService.getPrimaryOhlcvData(symbol);
    const exitPrice = finalRaw?.[finalRaw.length - 1]?.[4] ?? entryPrice;
    const pnl = isLong
        ? (exitPrice - entryPrice) / entryPrice
        : (entryPrice - exitPrice) / entryPrice;

    await dbService.closeSimulatedTrade(signalId, 'timeout', Math.round(pnl * 1e8));
    logger.info(`Simulated trade TIMED OUT`, { symbol, pnl: pnl.toFixed(6), signalId });
    return { outcome: 'timeout', pnl };
}
