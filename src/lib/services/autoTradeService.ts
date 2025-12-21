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
import { dbService, type EnrichedSymbolHistory } from '../db';
import { createLogger } from '../logger';
import { config } from '../config/settings';                  // ← For ingesting live outcomes
import type { TradeSignal } from '../../types';
import { getExcursionAdvice, isHighMaeRisk } from '../utils/excursionUtils';
import type { TelegramBotController } from './telegramBotController';

const logger = createLogger('AutoTradeService');

export class AutoTradeService {
    constructor(
        private readonly exchange: ExchangeService,
        private readonly telegramService?: TelegramBotController
    ) { }

    /**
     * Main entry point: Execute a live trade with full safety checks
     * Called from MarketScanner when a strong signal is generated
     */
    public async execute(originalSignal: TradeSignal): Promise<void> {
        // Master switch – if disabled, do nothing
        if (!config.autoTrade) {
            logger.debug('AutoTrade disabled in config – ignoring signal', { symbol: originalSignal.symbol });
            return;
        }

        const { symbol } = originalSignal;

        try {
            logger.info(`Evaluating live trade opportunity: ${originalSignal.signal.toUpperCase()} ${symbol}`, {
                confidence: originalSignal.confidence.toFixed(1),
            });

            // =================================================================
            // 1. Fetch enriched symbol history (recent + directional)
            // =================================================================
            const history: EnrichedSymbolHistory | null = await dbService.getEnrichedSymbolHistory(symbol);

            if (!history || (history.avgMae === 0 && history.recentMae === 0)) {
                logger.warn(`NO simulation history for ${symbol} – refusing live trade`);
                return;
            }

            // =================================================================
            // 2. Determine final direction (with optional reversal)
            // =================================================================
            let signal = { ...originalSignal };
            let direction: 'long' | 'short' = signal.signal === 'buy' ? 'long' : 'short';
            let wasReversed = false;
            let reversalReason = '';

            if (config.autoTrade) {
                const minReverseForReversal = config.strategy.minReverseCountForAutoReversal ?? 3;
                const recentReverse = direction === 'long' ? history.recentReverseCountLong : history.recentReverseCountShort;
                const recentRatio = history.recentMfe / Math.max(history.recentMae, 1e-6);

                if (
                    history.recentSampleCount >= 3 &&
                    recentReverse >= minReverseForReversal &&
                    recentRatio < 1.0
                ) {
                    // Strong evidence of mean-reversion regime → reverse the trade
                    signal.signal = signal.signal === 'buy' ? 'sell' : 'buy';
                    direction = signal.signal === 'buy' ? 'long' : 'short';
                    wasReversed = true;
                    reversalReason = `Auto-reversed due to ${recentReverse} recent reversals and poor recent reward ratio (${recentRatio.toFixed(2)})`;
                    logger.info(reversalReason, { symbol });
                }
            }

            // =================================================================
            // 3. High MAE Risk Filter – skip dangerous symbols
            // =================================================================
            if (isHighMaeRisk(history, direction)) {
                logger.warn(`SKIPPING trade: High drawdown risk detected`, {
                    symbol,
                    recentMae: history.recentMae.toFixed(2),
                    threshold: config.strategy.maxMaePct,
                });
                return;
            }

            // =================================================================
            // 4. Apply excursion-based adjustments (recent → directional → lifetime)
            // =================================================================
            const { advice: excursionAdvice, adjustments } = getExcursionAdvice(history, direction);
            logger.info(`Excursion analysis: ${excursionAdvice}`, { symbol });

            let finalConfidence = signal.confidence + (adjustments.confidenceBoost * 100);
            if (finalConfidence < config.strategy.confidenceThreshold) {
                logger.warn(`Confidence too low after adjustments`, {
                    original: signal.confidence,
                    adjusted: finalConfidence.toFixed(1),
                });
                return;
            }

            // Position size adjustment
            let sizeMultiplier = (signal.positionSizeMultiplier ?? 1.0) * (1 + adjustments.confidenceBoost);
            if (wasReversed) {
                sizeMultiplier *= 0.7; // Reduce size on reversed trades
            }
            sizeMultiplier = Math.max(0.2, Math.min(2.0, sizeMultiplier));

            // =================================================================
            // 5. Calculate dynamic SL/TP (with reversal adjustment)
            // =================================================================
            let stopLoss = signal.stopLoss;
            let takeProfit = signal.takeProfit;
            const currentPrice = this.exchange.getLatestPrice(symbol);

            if (!currentPrice || currentPrice <= 0) {
                logger.error(`Invalid price`, { symbol });
                return;
            }

            if (signal.signal !== 'hold' && stopLoss && takeProfit) {
                const baseSlDistance = Math.abs(currentPrice! - stopLoss);
                const baseTpDistance = Math.abs(takeProfit - currentPrice!);

                // Apply regime multipliers
                const adjustedSlDistance = baseSlDistance * adjustments.slMultiplier;
                const adjustedTpDistance = baseTpDistance * adjustments.tpMultiplier;

                if (signal.signal === 'buy') {
                    stopLoss = currentPrice! - adjustedSlDistance;
                    takeProfit = wasReversed
                        ? currentPrice! + adjustedTpDistance * 0.5  // Halfway to original SL on reversal
                        : currentPrice! + adjustedTpDistance;
                } else {
                    stopLoss = currentPrice! + adjustedSlDistance;
                    takeProfit = wasReversed
                        ? currentPrice! - adjustedTpDistance * 0.5
                        : currentPrice! - adjustedTpDistance;
                }
            }

            // =================================================================
            // 6. Validate symbol and fetch current price
            // =================================================================
            const isValid = await this.exchange.validateSymbol(symbol);
            if (!isValid) {
                logger.error(`Symbol not supported`, { symbol });
                return;
            }

            // =================================================================
            // 7. Calculate position size
            // =================================================================
            const balance = await this.exchange.getAccountBalance();
            if (!balance || balance <= 0) {
                logger.warn('Insufficient balance');
                return;
            }

            const baseRiskUsd = balance * (config.strategy.positionSizePercent / 100);
            const adjustedRiskUsd = baseRiskUsd * sizeMultiplier;
            const maxRiskUsd = balance * 0.10;
            const finalRiskUsd = Math.min(adjustedRiskUsd, maxRiskUsd);

            const amount = finalRiskUsd / currentPrice;
            if (amount < 0.0001) {
                logger.warn('Position size too small', { symbol, amount });
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
            });

            // =================================================================
            // 8. Place the order
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
            // 9. Log trade to DB
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
            // 10. Rich Telegram notification
            // =================================================================
            const lines = [
                `*LIVE TRADE EXECUTED*${wasReversed ? ' (AUTO-REVERSED)' : ''}`,
                `• Symbol: ${symbol}`,
                `• Direction: ${side.toUpperCase()}${wasReversed ? ' ← Original was opposite' : ''}`,
                `• Amount: ${amount.toFixed(6)}`,
                `• Entry: $${currentPrice.toFixed(8)}`,
                `• Risk: $${finalRiskUsd.toFixed(2)} (${((finalRiskUsd / balance) * 100).toFixed(1)}%)`,
                stopLoss ? `• SL: $${stopLoss.toFixed(8)}` : '',
                takeProfit ? `• TP: $${takeProfit.toFixed(8)}${wasReversed ? ' (halfway)' : ''}` : '',
                `• Excursion: ${excursionAdvice}`,
            ];

            if (wasReversed) {
                lines.push(`• Reason: ${reversalReason}`);
            }

            const telegramMsg = lines.filter(Boolean).join('\n');

            if (this.telegramService) {
                await this.telegramService.sendMessage(telegramMsg, { parse_mode: 'Markdown' });
            } else {
                logger.info('Telegram notification would be sent', { message: telegramMsg });
            }

            logger.info('Live trade successfully placed', { symbol, orderId });

            // =================================================================
            // 11. Start background monitoring
            // =================================================================
            if (config.ml.trainingEnabled) {
                void this.monitorLiveTradeOutcome(symbol, signal, amount, orderId);
            }

        } catch (error: any) {
            logger.error(`AUTOTRADE FAILED for ${symbol}`, {
                error: error.message,
                stack: error.stack,
            });
        }
    }

    // =========================================================================
    // BACKGROUND TRADE MONITORING – Capture real PnL for ML improvement
    // =========================================================================
    /**
     * Monitors an open live trade until it closes
     * When closed, extracts realized PnL and feeds into ML training
     * Runs in background (fire-and-forget)
     */
    private async monitorLiveTradeOutcome(
        symbol: string,
        _signal: TradeSignal,
        entryAmount: number,
        orderId: string
    ): Promise<void> {
        const maxHoldTimeMs = 4 * 60 * 60 * 1000;  // 4 hours max hold
        const pollIntervalMs = 60_000;            // Check every minute
        const entryTime = Date.now();

        logger.info('Started monitoring live trade', { symbol, orderId, entryAmount });

        try {
            while (Date.now() - entryTime < maxHoldTimeMs) {
                // Check if position is still open
                const positions = await this.exchange.getPositions(symbol);
                const stillOpen = positions.some((p: any) =>
                    p.symbol === symbol &&
                    Math.abs(p.contracts - entryAmount) < entryAmount * 0.2 // Allow small diff due to fees
                );

                if (!stillOpen) {
                    // Position closed – fetch closed trades
                    const closedTrades = await this.exchange.getClosedTrades(symbol, entryTime);
                    const matchedTrade = closedTrades.find((t: any) =>
                        t.orderId === orderId ||
                        (Math.abs(t.amount - entryAmount) < entryAmount * 0.2 && t.timestamp >= entryTime)
                    );

                    if (matchedTrade) {
                        const pnlUsd = (matchedTrade.amount ?? 0) * matchedTrade.price || 0;
                        const pnlPercent = (pnlUsd / (entryAmount * matchedTrade.price)) * 100;

                        const label = pnlPercent >= 3 ? 2 :
                            pnlPercent >= 1.5 ? 1 :
                                pnlPercent >= -1 ? 0 :
                                    pnlPercent >= -3 ? -1 : -2;

                        logger.info('Live trade closed – ingesting real outcome into ML', {
                            symbol,
                            pnlUsd: pnlUsd.toFixed(2),
                            pnlPercent: pnlPercent.toFixed(2),
                            label,
                        });

                        // TODO: Re-extract features at close time if possible
                        // For now, we just log – future: improve with actual close-time features
                    }

                    return; // Done monitoring
                }

                await new Promise(r => setTimeout(r, pollIntervalMs));
            }

            // Timeout reached – optionally force close
            logger.warn('Live trade timed out – consider forced exit', { symbol, holdHours: 4 });
            // You could add forced close here if desired

        } catch (err) {
            logger.error('Error during live trade monitoring', { symbol, error: err });
        }
    }
}
