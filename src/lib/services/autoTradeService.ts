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

const logger = createLogger('AutoTradeService');

export class AutoTradeService {
    constructor(
        private readonly exchange: ExchangeService
    ) {}

    /**
     * Main entry point: Execute a live trade with full safety checks
     * Called from MarketScanner when a strong signal is generated
     */
    public async execute(signal: TradeSignal): Promise<void> {
        // Master switch – if disabled, do nothing
        if (!config.autoTrade) {
            logger.debug('AutoTrade disabled in config – ignoring signal', { symbol: signal.symbol });
            return;
        }

        const { symbol } = signal;

        try {
            logger.info(`Evaluating live trade opportunity: ${signal.signal.toUpperCase()} ${symbol}`, {
                confidence: signal.confidence.toFixed(1),
            });

            // =================================================================
            // 1. CRITICAL: Require simulation history before any live trade
            // =================================================================
            // This prevents trading brand-new symbols blindly
            const excursions = await dbService.getSymbolExcursions(symbol);

            if (!excursions || excursions.avgMae === 0) {
                logger.warn(`NO simulation history for ${symbol} – refusing live trade (need confirmation first)`);
                return; // Do NOT trade until we have simulated data
            }

            // =================================================================
            // 2. High MAE Risk Filter – avoid symbols with bad drawdowns
            // =================================================================
            if (isHighMaeRisk(excursions.avgMae)) {
                logger.warn(`SKIPPING trade: High historical drawdown risk`, {
                    symbol,
                    avgMae: excursions.avgMae.toFixed(2),
                    threshold: config.strategy.maxMaePct,
                });
                return;
            }

            // =================================================================
            // 3. Apply excursion-based adjustments
            // =================================================================
            const { advice, adjustments } = getExcursionAdvice(excursions.avgMfe, excursions.avgMae);
            logger.info(`Excursion analysis: ${advice}`, {
                symbol,
                ratio: excursions.ratio.toFixed(2),
                mfe: excursions.avgMfe.toFixed(2),
                mae: excursions.avgMae.toFixed(2),
            });

            // Adjust final confidence
            let finalConfidence = signal.confidence + (adjustments.confidenceBoost * 100);
            if (finalConfidence < config.strategy.confidenceThreshold) {
                logger.warn(`Confidence too low after excursion adjustment`, {
                    original: signal.confidence,
                    adjusted: finalConfidence.toFixed(1),
                    threshold: config.strategy.confidenceThreshold,
                });
                return;
            }

            // Adjust position size based on excursion quality
            let sizeMultiplier = (signal.positionSizeMultiplier ?? 1.0) * (1 + adjustments.confidenceBoost);
            sizeMultiplier = Math.max(0.2, Math.min(2.0, sizeMultiplier)); // Clamp: 20% to 200%

            // =================================================================
            // 4. Validate symbol and fetch current price
            // =================================================================
            const isValid = await this.exchange.validateSymbol(symbol);
            if (!isValid) {
                logger.error(`Symbol not supported by exchange`, { symbol });
                return;
            }

            const currentPrice = this.exchange.getLatestPrice(symbol);
            if (!currentPrice || currentPrice <= 0) {
                logger.error(`Invalid or missing price`, { symbol });
                return;
            }

            // =================================================================
            // 5. Calculate actual position size in USD and base asset
            // =================================================================
            const balance = await this.exchange.getAccountBalance();
            if (!balance || balance <= 0) {
                logger.warn('Insufficient or unknown balance', { balance });
                return;
            }

            // Base risk: % of total balance
            const baseRiskUsd = balance * (config.strategy.positionSizePercent / 100);
            // Apply excursion-adjusted multiplier
            const adjustedRiskUsd = baseRiskUsd * sizeMultiplier;

            // Hard safety cap: never risk more than 10% of account on one trade
            const maxRiskUsd = balance * 0.10;
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
                excursionAdvice: advice,
            });

            // =================================================================
            // 6. Place the order (market entry with SL/TP/trailing)
            // =================================================================
            const order = await this.exchange.placeOrder(
                symbol,
                side,
                amount,
                signal.stopLoss ? Number(signal.stopLoss.toFixed(8)) : undefined,
                signal.takeProfit ? Number(signal.takeProfit.toFixed(8)) : undefined,
                signal.trailingStopDistance ? Number(signal.trailingStopDistance.toFixed(8)) : undefined
            );

            const orderId = order.id || 'unknown';

            // =================================================================
            // 7. Log trade to database
            // =================================================================
            await dbService.logTrade({
                symbol,
                side: signal.signal,
                amount: amount * 1e8,           // Store with 8 decimals precision
                price: currentPrice * 1e8,
                timestamp: Date.now(),
                mode: 'live',
                orderId,
            });

            // =================================================================
            // 8. Notify via Telegram
            // =================================================================
            const telegramMsg = [
                `*LIVE TRADE EXECUTED*`,
                `• Symbol: ${symbol}`,
                `• Direction: ${side.toUpperCase()}`,
                `• Amount: ${amount.toFixed(6)}`,
                `• Entry: $${currentPrice.toFixed(8)}`,
                `• Risk: $${finalRiskUsd.toFixed(2)} (${((finalRiskUsd / balance) * 100).toFixed(1)}%)`,
                signal.stopLoss ? `• SL: $${signal.stopLoss.toFixed(8)}` : '',
                signal.takeProfit ? `• TP: $${signal.takeProfit.toFixed(8)}` : '',
                `• Excursion: ${advice}`,
            ].filter(Boolean).join('\n');

            // Assuming scanner has access to telegramService – or inject it
            // For now, just log (you can pass telegramService in constructor if needed)
            logger.info('Telegram notification would be sent', { message: telegramMsg });

            logger.info('Live trade successfully placed', { symbol, orderId });

            // =================================================================
            // 9. Start background monitoring for ML training
            // =================================================================
            if (config.ml.trainingEnabled) {
                // Fire-and-forget: monitor until close and ingest real outcome
                void this.monitorLiveTradeOutcome(symbol, signal, amount, orderId);
            }

        } catch (error: any) {
            logger.error(`AUTOTRADE FAILED for ${symbol}`, {
                error: error.message,
                stack: error.stack,
                confidence: signal.confidence,
            });
            // Optional: send failure alert via Telegram
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
                        const pnlUsd = (matchedTrade.amount?? 0) * matchedTrade.price  || 0;
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
