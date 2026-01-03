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
import { config } from '../config/settings';                  // ← For ingesting live outcomes
import type { TradeSignal } from '../../types';
import { getExcursionAdvice, isHighMaeRisk } from '../utils/excursionUtils';
import type { TelegramBotController } from './telegramBotController';
import { computeLabel } from './simulateTrade';

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
            const regime = await dbService.getCurrentRegime(symbol);

            if (regime.sampleCount === 0) {
                logger.warn(`NO simulation history yet for ${symbol} – refusing live trade`);
                return;
            }

            // =================================================================
            // 2. Auto-reversal logic using live regime
            // =================================================================
            let signal = { ...originalSignal };
            let direction: 'long' | 'short' = signal.signal === 'buy' ? 'long' : 'short';
            let wasReversed = false;
            let reversalReason = '';

            const minReverseForReversal = config.strategy.minReverseCountForAutoReversal ?? 3;

            if (
                regime.sampleCount >= 3 &&
                regime.reverseCount >= minReverseForReversal &&
                regime.excursionRatio < 1.0
            ) {
                // Strong mean-reversion regime detected → reverse
                signal.signal = signal.signal === 'buy' ? 'sell' : 'buy';
                direction = signal.signal === 'buy' ? 'long' : 'short';
                wasReversed = true;
                reversalReason = `Auto-reversed: ${regime.reverseCount} reversals, ratio ${regime.excursionRatio.toFixed(2)} (live+recent)`;
                logger.info(reversalReason, { symbol });
            }

            // =================================================================
            // 3. High drawdown risk filter (using live MAE)
            // =================================================================
            if (isHighMaeRisk(regime as any, direction)) {  // Temporary cast until utils updated
                logger.warn(`SKIPPING trade: High live drawdown risk`, {
                    symbol,
                    liveMae: regime.mae.toFixed(2),
                    threshold: config.strategy.maxMaePct,
                    activeSims: regime.activeCount,
                });
                return;
            }

            // =================================================================
            // 4. Excursion-based adjustments using live regime
            // =================================================================
            const { advice: excursionAdvice, adjustments } = getExcursionAdvice(regime as any, direction);
            logger.info(`Excursion advice: ${excursionAdvice}`, { symbol });

            let finalConfidence = signal.confidence + (adjustments.confidenceBoost * 100);
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
            let sizeMultiplier = (signal.positionSizeMultiplier ?? 1.0) * (1 + adjustments.confidenceBoost);
            if (wasReversed) {
                sizeMultiplier *= 0.7; // Reduce size on reversals
            }
            sizeMultiplier = Math.max(0.2, Math.min(2.0, sizeMultiplier));

            // =================================================================
            // 6. Dynamic SL/TP adjustment
            // =================================================================
            let stopLoss = signal.stopLoss;
            let takeProfit = signal.takeProfit;
            const currentPrice = this.exchange.getLatestPrice(symbol);

            if (!currentPrice || currentPrice <= 0) {
                logger.error('Invalid current price', { symbol });
                return;
            }

            if (signal.signal !== 'hold' && stopLoss && takeProfit) {
                const baseSlDistance = Math.abs(currentPrice - stopLoss);
                const baseTpDistance = Math.abs(takeProfit - currentPrice);

                const adjustedSlDistance = baseSlDistance * adjustments.slMultiplier;
                const adjustedTpDistance = baseTpDistance * adjustments.tpMultiplier;

                if (signal.signal === 'buy') {
                    stopLoss = currentPrice - adjustedSlDistance;
                    takeProfit = wasReversed
                        ? currentPrice + adjustedTpDistance * 0.5
                        : currentPrice + adjustedTpDistance;
                } else {
                    stopLoss = currentPrice + adjustedSlDistance;
                    takeProfit = wasReversed
                        ? currentPrice - adjustedTpDistance * 0.5
                        : currentPrice - adjustedTpDistance;
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
                excursionAdvice,
                liveSamples: regime.sampleCount,
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
                takeProfit ? `• TP: $${takeProfit.toFixed(8)}${wasReversed ? ' (halfway)' : ''}` : '',
                `• Excursion: ${excursionAdvice}`,
                `• Live Regime: ${regime.sampleCount} samples (${regime.activeCount} active) | Ratio ${regime.excursionRatio.toFixed(2)}`,
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
            // 12. Start monitoring (if enabled)
            // =================================================================
            if (config.ml.trainingEnabled) {
                void this.monitorLiveTradeOutcome(symbol, signal, amount, orderId, currentPrice);
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
        signal: TradeSignal,        // Keep for potential feature re-extraction later
        entryAmount: number,
        orderId: string,
        entryPrice: number          // Add entry price for accurate PnL calc
    ): Promise<void> {
        const maxHoldTimeMs = 4 * 60 * 60 * 1000;  // 4 hours
        const pollIntervalMs = 60_000;            // 1 minute
        const entryTime = Date.now();

        logger.info('Started monitoring live trade for ML ingestion', {
            symbol,
            orderId,
            entryAmount: entryAmount.toFixed(6),
            entryPrice: entryPrice.toFixed(8),
        });

        try {
            while (Date.now() - entryTime < maxHoldTimeMs) {
                // Check if position is still open
                const positions = await this.exchange.getPositions(symbol);
                const stillOpen = positions.some((p: any) =>
                    p.symbol === symbol &&
                    Math.abs(p.contracts - entryAmount) > entryAmount * 0.01  // >1% remaining
                );

                if (!stillOpen) {
                    // Position closed — fetch recent closed trades
                    const closedTrades = await this.exchange.getClosedTrades(symbol, entryTime - 60_000); // slight buffer

                    // Find matching trade by orderId or amount + time
                    const matchedTrade = closedTrades.find((t: any) =>
                        t.orderId === orderId ||
                        (Math.abs(t.amount - entryAmount) < entryAmount * 0.2 &&
                            t.timestamp >= entryTime)
                    );

                    if (matchedTrade) {
                        // Calculate real PnL
                        const exitPrice = matchedTrade.price || matchedTrade.amount || 0;
                        const pnlPercent = signal.signal === 'buy'
                            ? ((exitPrice - entryPrice) / entryPrice) * 100
                            : ((entryPrice - exitPrice) / entryPrice) * 100;

                        const riskPercent = 1.5; // e.g., 1.5%
                        const rMultiple = pnlPercent / riskPercent;

                        // 5-tier label based on real R-multiple
                        const label = computeLabel(rMultiple);

                        logger.info('Live trade closed – ingesting real outcome into ML training', {
                            symbol,
                            orderId,
                            entryPrice: entryPrice.toFixed(8),
                            exitPrice: exitPrice.toFixed(8),
                            pnlPercent: pnlPercent.toFixed(2),
                            rMultiple: rMultiple.toFixed(3),
                            label,
                        });

                        // Ingest into ML as a high-value real sample
                        // Note: features are dummy here — future improvement: re-extract at close time
                        await dbService.addTrainingSample({
                            symbol,
                            features: new Array(50).fill(0), // placeholder — replace with real features later
                            label,
                            // Optional: add metadata like isLive: true
                        });
                    } else {
                        logger.warn('Live trade closed but no matching closed trade record found', {
                            symbol,
                            orderId,
                            entryAmount,
                        });
                    }

                    return; // Done
                }

                await new Promise(r => setTimeout(r, pollIntervalMs));
            }

            // Timeout reached
            logger.warn('Live trade monitoring timed out after 4 hours', {
                symbol,
                orderId,
                holdHours: 4,
            });
            // Optional: force close or alert here

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
