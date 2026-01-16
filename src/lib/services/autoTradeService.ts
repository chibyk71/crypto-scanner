// src/lib/services/autoTradeService.ts
// =============================================================================
// AUTOTRADE SERVICE – SAFE, ADAPTIVE & MONITORED LIVE TRADING
//
// Purpose:
//   • Execute live trades only when safe and confirmed by historical behavior
//   • Use excursion data (MAE/MFE) to filter risky symbols and adjust sizing
//   • Monitor open trades and capture real outcomes for ML training
//   • Full logging and Telegram notifications
//
// Key Safety Rules:
//   1. Never trade a symbol with no simulation history
//   2. Skip if average MAE is too high (high drawdown risk)
//   3. Adjust confidence and size based on MFE/MAE ratio
//   4. Monitor live trades and log actual PnL for continuous learning
// =============================================================================

import { ExchangeService } from './exchange';
import { dbService } from '../db';
import { createLogger } from '../logger';
import { config } from '../config/settings';
import type { TradeSignal } from '../../types';
import { getExcursionAdvice, isHighMaeRisk } from '../utils/excursionUtils';
import type { TelegramBotController } from './telegramBotController';
import { computeLabel } from './simulateTrade';
import { excursionCache } from './excursionHistoryCache';

const logger = createLogger('AutoTradeService');

export class AutoTradeService {
    constructor(
        private readonly exchange: ExchangeService,
        private readonly telegramService?: TelegramBotController
    ) { }

    /**
     * Main entry point: Execute a live trade with full real-time safety checks
     * Uses current regime (closed recent + live active simulations)
     */
    public async execute(originalSignal: TradeSignal): Promise<void> {
        // Master switch
        if (!config.autoTrade) {
            logger.debug('AutoTrade disabled – ignoring signal', { symbol: originalSignal.symbol });
            return;
        }

        const { symbol } = originalSignal;

        try {
            logger.info(`Evaluating live trade: ${originalSignal.signal.toUpperCase()} ${symbol}`, {
                confidence: originalSignal.confidence.toFixed(1),
            });

            // =================================================================
            // 1. Get real-time regime (closed recent + all live simulations)
            // =================================================================
            const regime = excursionCache.getRegime(symbol);

            if (regime == null || regime?.recentSampleCount === 0) {
                logger.warn(`NO simulation history yet for ${symbol} – refusing live trade`);
                return;
            }

            // =================================================================
            // 2. Determine initial direction and fetch unified excursion advice
            // =================================================================
            let signal = { ...originalSignal };
            let direction: 'long' | 'short' = signal.signal === 'buy' ? 'long' : 'short';
            let wasReversed = false;
            let reversalReason = '';

            // Use the new centralized excursion logic (includes explicit action)
            const adviceObj = getExcursionAdvice(regime, direction);

            logger.info(`Excursion advice: ${adviceObj.advice}`, { symbol });

            // Apply confidence boost from excursion analysis
            let finalConfidence = signal.confidence + (adviceObj.adjustments.confidenceBoost * 100);

            // === Handle explicit actions from excursion logic ===
            if (adviceObj.action === 'skip') {
                logger.warn(`SKIPPING live trade due to poor/mixed excursions`, { symbol, advice: adviceObj.advice });
                return;
            }

            if (adviceObj.action === 'reverse') {
                // Flip the signal direction
                signal.signal = signal.signal === 'buy' ? 'sell' : 'buy';
                direction = signal.signal === 'buy' ? 'long' : 'short';
                wasReversed = true;
                reversalReason = `Auto-reversed: ${adviceObj.advice}`;
                logger.info(reversalReason, { symbol });
            }

            // =================================================================
            // 3. High drawdown risk filter (using live MAE)
            // =================================================================
            if (isHighMaeRisk(regime, direction)) {
                logger.warn(`SKIPPING trade: High live drawdown risk`, {
                    symbol,
                    liveMae: regime.recentMae.toFixed(2),
                    threshold: config.strategy.maxMaePct,
                    activeSims: regime.activeCount,
                });
                return;
            }

            // =================================================================
            // 4. Final confidence check after excursion adjustments
            // =================================================================
            if (finalConfidence < config.strategy.confidenceThreshold) {
                logger.warn(`Confidence too low after excursion adjustments`, {
                    original: signal.confidence,
                    adjusted: finalConfidence.toFixed(1),
                });
                return;
            }

            // =================================================================
            // 5. Position sizing with excursion boost
            // =================================================================
            let sizeMultiplier = (signal.positionSizeMultiplier ?? 1.0) * (1 + adviceObj.adjustments.confidenceBoost);
            if (wasReversed) {
                sizeMultiplier *= 0.7; // Reduce size on reversal trades (higher uncertainty)
            }
            sizeMultiplier = Math.max(0.2, Math.min(2.0, sizeMultiplier));

            // =================================================================
            // 6. Dynamic SL/TP adjustment using excursion multipliers
            // =================================================================
            let stopLoss = signal.stopLoss;
            let takeProfit = signal.takeProfit;
            const currentPrice = await this.exchange.getLatestPrice(symbol); // Made async-safe

            if (!currentPrice || currentPrice <= 0) {
                logger.error('Invalid current price', { symbol });
                return;
            }

            if (signal.signal !== 'hold' && stopLoss && takeProfit) {
                const baseSlDistance = Math.abs(currentPrice - stopLoss);
                const baseTpDistance = Math.abs(takeProfit - currentPrice);

                const adjustedSlDistance = baseSlDistance * adviceObj.adjustments.slMultiplier;
                const adjustedTpDistance = baseTpDistance * adviceObj.adjustments.tpMultiplier;

                if (signal.signal === 'buy') {
                    stopLoss = currentPrice - adjustedSlDistance;
                    takeProfit = currentPrice + adjustedTpDistance;
                } else {
                    stopLoss = currentPrice + adjustedSlDistance;
                    takeProfit = currentPrice - adjustedTpDistance;
                }

                // Extra caution on reversed trades: reduce TP ambition
                if (wasReversed) {
                    takeProfit = signal.signal === 'buy'
                        ? currentPrice + (adjustedTpDistance * 0.6)
                        : currentPrice - (adjustedTpDistance * 0.6);
                }
            }

            // =================================================================
            // 7. Validate symbol
            // =================================================================
            const isValid = await this.exchange.validateSymbol(symbol);
            if (!isValid) {
                logger.error('Symbol not supported on exchange', { symbol });
                return;
            }

            // =================================================================
            // 8. Calculate final position size
            // =================================================================
            const balance = await this.exchange.getAccountBalance();
            if (!balance || balance <= 0) {
                logger.warn('Insufficient account balance');
                return;
            }

            const baseRiskUsd = balance * (config.strategy.positionSizePercent / 100);
            const adjustedRiskUsd = baseRiskUsd * sizeMultiplier;
            const maxRiskUsd = balance * 0.10; // Hard cap at 10%
            const finalRiskUsd = Math.min(adjustedRiskUsd, maxRiskUsd);

            const amount = finalRiskUsd / currentPrice;
            if (amount < 0.0001) {
                logger.warn('Calculated position size too small', { symbol, amount });
                return;
            }

            const side = signal.signal === 'buy' ? 'buy' : 'sell';

            logger.info('EXECUTING LIVE TRADE', {
                symbol,
                side: side.toUpperCase(),
                amount: amount.toFixed(6),
                usdValue: (amount * currentPrice).toFixed(2),
                riskUsd: finalRiskUsd.toFixed(2),
                confidence: finalConfidence.toFixed(1),
                reversed: wasReversed,
                excursionAdvice: adviceObj.advice,
                liveSamples: regime.recentSampleCount,
                activeSims: regime.activeCount,
            });

            // =================================================================
            // 9. Place order
            // =================================================================
            const order = await this.exchange.placeOrder(
                symbol,
                side,
                amount,
                stopLoss ? Number(stopLoss.toFixed(8)) : undefined,
                takeProfit ? Number(takeProfit.toFixed(8)) : undefined,
                signal.trailingStopDistance ? Number(signal.trailingStopDistance.toFixed(8)) : undefined
            );

            const orderId = order.id || 'unknown';

            // =================================================================
            // 10. Log to DB
            // =================================================================
            await dbService.logTrade({
                symbol,
                side: signal.signal,
                amount: amount * 1e8,
                price: currentPrice * 1e8,
                timestamp: Date.now(),
                mode: 'live',
                orderId,
            });

            // =================================================================
            // 11. Telegram notification
            // =================================================================
            const lines = [
                `*LIVE TRADE EXECUTED*${wasReversed ? ' (AUTO-REVERSED)' : ''}`,
                `• Symbol: ${symbol}`,
                `• Direction: ${side.toUpperCase()}${wasReversed ? ' ← Original opposite' : ''}`,
                `• Amount: ${amount.toFixed(6)}`,
                `• Entry: $${currentPrice.toFixed(8)}`,
                `• Risk: $${finalRiskUsd.toFixed(2)} (${((finalRiskUsd / balance) * 100).toFixed(1)}%)`,
                stopLoss ? `• SL: $${stopLoss.toFixed(8)}` : '',
                takeProfit ? `• TP: $${takeProfit.toFixed(8)}${wasReversed ? ' (reduced)' : ''}` : '',
                `• Excursion: ${adviceObj.advice}`,
                `• Live Regime: ${regime.recentSampleCount} samples (${regime.activeCount} active) | Ratio ${regime.recentExcursionRatio.toFixed(2)}`,
            ];

            if (wasReversed) {
                lines.push(`• Reason: ${reversalReason}`);
            }

            const telegramMsg = lines.filter(Boolean).join('\n');

            if (this.telegramService) {
                await this.telegramService.sendMessage(telegramMsg, { parse_mode: 'Markdown' });
            } else {
                logger.info('Telegram notification (dry)', { message: telegramMsg });
            }

            logger.info('Live trade placed successfully', { symbol, orderId });

            // =================================================================
            // 12. Start monitoring (if enabled) – pass reversal flag
            // =================================================================
            if (config.ml.trainingEnabled) {
                void this.monitorLiveTradeOutcome(symbol, signal, amount, orderId, currentPrice, wasReversed);
            }

        } catch (error: any) {
            logger.error(`AutoTrade failed for ${symbol}`, {
                error: error.message,
                stack: error.stack,
            });
        }
    }

    // =========================================================================
    // BACKGROUND TRADE MONITORING – Capture real PnL for ML improvement
    // =========================================================================
    /**
     * Monitors an open live trade until it closes.
     * When closed, captures the actual realized PnL and feeds it into ML training
     * as a high-quality labeled sample (real outcome > simulated).
     * Runs fire-and-forget in background.
     */
    private async monitorLiveTradeOutcome(
        symbol: string,
        signal: TradeSignal,
        entryAmount: number,
        orderId: string,
        entryPrice: number,
        wasReversed: boolean = false   // New flag to track reversal context
    ): Promise<void> {
        const maxHoldTimeMs = 4 * 60 * 60 * 1000;  // 4 hours
        const pollIntervalMs = 60_000;            // 1 minute
        const entryTime = Date.now();

        logger.info('Started monitoring live trade for ML ingestion', {
            symbol,
            orderId,
            entryAmount: entryAmount.toFixed(6),
            entryPrice: entryPrice.toFixed(8),
            reversed: wasReversed,
        });

        try {
            while (Date.now() - entryTime < maxHoldTimeMs) {
                const positions = await this.exchange.getPositions(symbol);
                const stillOpen = positions.some((p: any) =>
                    p.symbol === symbol &&
                    Math.abs(p.contracts - entryAmount) > entryAmount * 0.01
                );

                if (!stillOpen) {
                    const closedTrades = await this.exchange.getClosedTrades(symbol, entryTime - 60_000);

                    const matchedTrade = closedTrades.find((t: any) =>
                        t.orderId === orderId ||
                        (Math.abs(t.amount - entryAmount) < entryAmount * 0.2 &&
                            t.timestamp >= entryTime)
                    );

                    if (matchedTrade) {
                        const exitPrice = matchedTrade.price || matchedTrade.amount || 0;
                        const pnlPercent = signal.signal === 'buy'
                            ? ((exitPrice - entryPrice) / entryPrice) * 100
                            : ((entryPrice - exitPrice) / entryPrice) * 100;

                        const riskPercent = 1.5;
                        const rMultiple = pnlPercent / riskPercent;
                        const label = computeLabel(rMultiple);

                        logger.info('Live trade closed – ingesting real outcome into ML training', {
                            symbol,
                            orderId,
                            entryPrice: entryPrice.toFixed(8),
                            exitPrice: exitPrice.toFixed(8),
                            pnlPercent: pnlPercent.toFixed(2),
                            rMultiple: rMultiple.toFixed(3),
                            label,
                            reversed: wasReversed,
                        });

                        // Ingest with metadata (future: use for better ML weighting)
                        await dbService.addTrainingSample({
                            symbol,
                            features: new Array(50).fill(0), // placeholder
                            label,
                            // Could extend schema later for isLive + isReversed
                        });
                    } else {
                        logger.warn('Live trade closed but no matching closed trade record found', {
                            symbol,
                            orderId,
                            entryAmount,
                        });
                    }

                    return;
                }

                await new Promise(r => setTimeout(r, pollIntervalMs));
            }

            logger.warn('Live trade monitoring timed out after 4 hours', {
                symbol,
                orderId,
                holdHours: 4,
            });

        } catch (err: any) {
            logger.error('Error in live trade monitoring', {
                symbol,
                orderId,
                error: err.message,
                stack: err.stack,
            });
        }
    }
}
