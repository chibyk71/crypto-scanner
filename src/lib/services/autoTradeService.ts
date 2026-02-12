// src/lib/services/autoTradeService.ts
// =============================================================================
// AUTOTRADE SERVICE – MINIMAL, FAST & SAFE EXECUTION
//
// Now simplified per user request:
//   • Execute as fast as possible after signal arrives
//   • Fixed USD amount from config (no balance fetch)
//   • Leverage is pre-set on exchange account (20x or whatever you chose)
//   • Trusts upstream checks (strategy + excursion advice)
//   • Minimal safety (symbol support + price)
//   • Keeps trailing stop from signal
//   • Short Telegram notification
//   • Light logging of close (optional)
// =============================================================================

import { ExchangeService } from './exchange';
import { createLogger } from '../logger';
import { config } from '../config/settings';
import type { TradeSignal } from '../../types';
import { getExcursionAdvice } from '../utils/excursionUtils';
import type { TelegramBotController } from './telegramBotController';
import { excursionCache } from './excursionHistoryCache';
// import { simulateTrade } from './simulateTrade';

const logger = createLogger('AutoTradeService');

/**
 * Main entry point: Execute a live trade as fast as possible
 * Assumes signal has already passed strategy + excursion checks
 */
export class AutoTradeService {

    // ────────────────────────────────────────────────────────────────
    // Execution cooldown & error tracking (new, minimal, global)
    // ────────────────────────────────────────────────────────────────
    private globalExecutionCooldownUntil: number = 0;      // timestamp when next trade allowed
    private consecutiveExecutionErrors: number = 0;
    private lastExecutionErrorTime: number = 0;

    private readonly EXECUTION_COOLDOWN_MS = 10 * 60 * 1000; // 10 min
    private readonly MAX_CONSECUTIVE_EXEC_ERRORS = 3;

    constructor(
        private readonly exchange: ExchangeService,
        private readonly telegramService?: TelegramBotController
    ) {
        // Initialize error tracking
        this.consecutiveExecutionErrors = 0;
        this.lastExecutionErrorTime = 0;
        this.globalExecutionCooldownUntil = 0;
    }

    /**
     * Main entry point: Execute a live trade as fast as possible (if enabled)
     * while serving as the FINAL GATEKEEPER for all regime-based decisions.
     *
     * 2026+ DESIGN PHILOSOPHY:
     *   - AutoTradeService is the single decision point for:
     *       • Excursion regime analysis (skip, reverse, adjust confidence)
     *       • Final SL/TP levels (with fixed leverage-aware rules)
     *       • Post-adjustment validation (valid risk/reward, safe exits)
     *       • Rich Telegram alerting (ALWAYS sent if signal passes validation)
     *       • Optional live order placement (only if config.autoTrade.enabled)
     *   - Receives RAW technical signal from scanner (base/unadjusted SL/TP)
     *   - Benefits:
     *       - No duplicated regime logic
     *       - Alerts reflect final decision (reversals, fixed levels)
     *       - Alerts sent even in simulation-only mode
     *       - Reversed trades get extra simulation for regime data
     *
     * LEVERAGE & RISK RULES (fixed for this version):
     *   - Leverage: 25×
     *   - Target account gain: +10% → requires 0.4% price move (10% / 25)
     *   - Max account loss: 1% → caps adverse price move at 0.04% (1% / 25)
     *   - TP: always set to 0.4% move from current price (ignores tpMultiplier)
     *   - SL: uses original signal SL distance, but capped at 0.04% adverse move
     *   - Multipliers (slMultiplier/tpMultiplier): IGNORED
     *   - Reversal: still applied if advice.action === 'reverse'
     *
     * @param signal Raw technical TradeSignal from Strategy (base SL/TP, no regime adjustments)
     */
    public async execute(signal: TradeSignal): Promise<void> {
        const symbol = signal.symbol;

        // ────────────────────────────────────────────────────────────────
        // 0. EARLY GUARD: Ignore 'hold' signals (scanner forwards everything)
        // ────────────────────────────────────────────────────────────────
        if (signal.signal === 'hold') {
            logger.debug(`Received HOLD signal – nothing to execute`, { symbol });
            return;
        }

        // ────────────────────────────────────────────────────────────────
        // 1. GLOBAL COOLDOWN: Prevent spam after success, funds error, or margin issue
        // ────────────────────────────────────────────────────────────────
        if (this.isExecutionCooldownActive()) {
            logger.debug('Global execution cooldown active – skipping trade/alert', { symbol });
            return;
        }

        // ────────────────────────────────────────────────────────────────
        // 2. SYMBOL SUPPORT CHECK: Fast in-memory validation
        // ────────────────────────────────────────────────────────────────
        const isSupported = await this.exchange.validateSymbol(symbol);
        if (!isSupported) {
            logger.warn(`Symbol not supported on exchange – skipping`, { symbol });
            return;
        }

        // ────────────────────────────────────────────────────────────────
        // 3. CURRENT PRICE: Use cached value (fast, no API call)
        // ────────────────────────────────────────────────────────────────
        const currentPrice = this.exchange.getLatestPrice(symbol);
        if (!currentPrice || currentPrice <= 0) {
            logger.warn(`Invalid or missing cached price – aborting`, { symbol });
            return;
        }

        try {
            // ────────────────────────────────────────────────────────────────
            // 4. FETCH REGIME + ADVICE: Core decision point (skip/reverse)
            // ────────────────────────────────────────────────────────────────
            const regime = excursionCache.getRegime(symbol);
            if (!regime || regime.recentSampleCount === 0) {
                logger.info(`No regime data available yet – skipping alert/trade`, { symbol });
                return;
            }

            const intendedDirection = signal.signal === 'buy' ? 'long' : 'short';
            const advice = getExcursionAdvice(regime, intendedDirection);

            logger.error(`Excursion advice for ${symbol}: ${advice.action.toUpperCase()}`, { symbol, adviceSummary: advice.advice });


            // Skip if regime says no-go
            if (advice.action === 'skip') {
                logger.info(`Excursion advice: SKIP – no alert or trade sent`, {
                    symbol,
                    adviceSummary: advice.advice
                });
                return;
            }

            // Extract adjustments (we'll ignore SL/TP multipliers, but keep confidence boost)
            const { confidenceBoost = 0 } = advice.adjustments ?? {};

            // ────────────────────────────────────────────────────────────────
            // 5. DETERMINE FINAL SIDE: Apply reversal if advised
            // ────────────────────────────────────────────────────────────────
            let finalSide: 'buy' | 'sell' = signal.signal;
            let wasReversed = false;

            if (advice.action === 'reverse') {
                finalSide = signal.signal === 'buy' ? 'sell' : 'buy';
                wasReversed = true;
                logger.info(`Regime reversal applied → switching to ${finalSide.toUpperCase()}`, { symbol });
            }

            // ────────────────────────────────────────────────────────────────
            // 6. FIXED TP: Always 0.4% price move = 10% account gain on 25×
            //    Ignores tpMultiplier completely
            // ────────────────────────────────────────────────────────────────
            const TARGET_ACCOUNT_GAIN = 0.10;  // 10% account target
            const LEVERAGE = 50;
            const TP_PRICE_MOVE = TARGET_ACCOUNT_GAIN / LEVERAGE; // 0.004 = 0.4%

            const finalTakeProfit = finalSide === 'buy'
                ? currentPrice * (1 + TP_PRICE_MOVE)
                : currentPrice * (1 - TP_PRICE_MOVE);

            // ────────────────────────────────────────────────────────────────
            // 7. SL: Use original signal SL distance, but CAP at 1% account risk
            //    (0.04% price move → 1% account loss on 25×)
            //    Ignores slMultiplier completely
            // ────────────────────────────────────────────────────────────────
            const MAX_ACCOUNT_RISK = 0.01;     // 1% max account loss
            const SL_PRICE_CAP_MOVE = MAX_ACCOUNT_RISK / LEVERAGE; // 0.0004 = 0.04%

            let finalStopLoss: number;

            if (signal.stopLoss !== undefined) {
                // Calculate original risk distance from raw signal
                const originalRiskDistance = finalSide === 'buy'
                    ? currentPrice - signal.stopLoss
                    : signal.stopLoss - currentPrice;

                // Cap at 0.04% price move
                const cappedRiskDistance = Math.min(originalRiskDistance, currentPrice * SL_PRICE_CAP_MOVE);

                finalStopLoss = finalSide === 'buy'
                    ? currentPrice - cappedRiskDistance
                    : currentPrice + cappedRiskDistance;
            } else {
                // Fallback: hard 0.04% SL if no original SL provided
                finalStopLoss = finalSide === 'buy'
                    ? currentPrice * (1 - SL_PRICE_CAP_MOVE)
                    : currentPrice * (1 + SL_PRICE_CAP_MOVE);
            }

            // ────────────────────────────────────────────────────────────────
            // 8. VALIDATION: Ensure levels are valid after capping
            // ────────────────────────────────────────────────────────────────
            const riskDistance = finalSide === 'buy'
                ? currentPrice - finalStopLoss
                : finalStopLoss - currentPrice;

            const rewardDistance = finalSide === 'buy'
                ? finalTakeProfit - currentPrice
                : currentPrice - finalTakeProfit;

            const achievedRR = rewardDistance / riskDistance;

            if (riskDistance <= 0 || rewardDistance <= 0 || achievedRR < 1) {
                logger.warn(`Invalid levels after fixed R:R cap – skipping alert/trade`, {
                    symbol,
                    riskDistance: riskDistance.toFixed(8),
                    rewardDistance: rewardDistance.toFixed(8),
                    achievedRR: achievedRR.toFixed(2),
                    finalSide,
                    wasReversed
                });
                return;
            }

            // ────────────────────────────────────────────────────────────────
            // 9. BUILD ADJUSTED SIGNAL FOR ALERTING & EXECUTION
            // ────────────────────────────────────────────────────────────────
            const adjustedSignal: TradeSignal = {
                ...signal,
                signal: finalSide,
                confidence: signal.confidence + confidenceBoost,
                stopLoss: Number(finalStopLoss.toFixed(8)),
                takeProfit: Number(finalTakeProfit.toFixed(8)),
                reason: [
                    ...signal.reason, // original technical reasons
                    advice.advice,
                    `Fixed 1:10 account R:R (25× leverage) – TP 0.4% move, SL capped at 0.04%`,
                    wasReversed ? '↔️ DIRECTION REVERSED' : '',
                    confidenceBoost !== 0 ? `Confidence boost: ${confidenceBoost > 0 ? '+' : ''}${confidenceBoost.toFixed(2)}` : ''
                ].filter(Boolean)
            };

            // ────────────────────────────────────────────────────────────────
            // 10. OPTIONAL: Extra simulation for reversed trades
            //     (original sim already ran in scanner)
            // ────────────────────────────────────────────────────────────────
            if (wasReversed) {
                logger.debug(`Triggering extra simulation for reversed trade`, {
                    symbol,
                    finalSide,
                    currentPrice: currentPrice.toFixed(8)
                });
                // void simulateTrade(this.exchangeService, symbol, adjustedSignal, currentPrice, adjustedSignal.features);
                // Note: feeds cache only — no ML feature extraction needed here
            }

            // ────────────────────────────────────────────────────────────────
            // 11. OPTIONAL LIVE ORDER PLACEMENT (only if enabled)
            // ────────────────────────────────────────────────────────────────
            let orderId: string | null = null;

            if (config.autoTrade.enabled) {
                const FIXED_QUOTE_USD = config.autoTrade.fixedTradeUsd ?? 20;
                const amount = FIXED_QUOTE_USD / currentPrice;

                if (amount < 0.0001) {
                    logger.info(`Calculated amount too small – skipping order`, { symbol, amount });
                } else {
                    try {
                        const order = await this.exchange.placeOrder(
                            symbol,
                            finalSide,
                            amount,
                            finalStopLoss,
                            finalTakeProfit,
                            signal.trailingStopDistance // keep original trailing if present
                        );

                        orderId = order.id || 'unknown';

                        logger.info(`Live trade executed successfully`, {
                            symbol,
                            side: finalSide.toUpperCase(),
                            amount: amount.toFixed(6),
                            usdValue: FIXED_QUOTE_USD,
                            orderId,
                            wasReversed,
                            adviceSummary: advice.advice
                        });
                    } catch (orderErr) {
                        logger.error(`Failed to place live order`, {
                            symbol,
                            side: finalSide,
                            error: orderErr instanceof Error ? orderErr.message : String(orderErr)
                        });
                    }
                }
            } else {
                logger.info(`Auto-trade disabled – no order placed (alert still sent)`, { symbol });
            }

            // ────────────────────────────────────────────────────────────────
            // 12. ALWAYS SEND RICH TELEGRAM ALERT
            //     (even if auto-trade off – reflects final decision)
            // ────────────────────────────────────────────────────────────────
            if (this.telegramService) {
                await this.telegramService.sendSignalAlert(
                    symbol,
                    adjustedSignal,
                    currentPrice,
                    orderId !== null // show if order was actually placed
                );

                logger.info(`Rich signal alert sent (${wasReversed ? 'REVERSED' : 'normal'})`, {
                    symbol,
                    finalSide,
                    orderPlaced: orderId !== null
                });

                // Optional follow-up with order ID
                if (orderId !== null) {
                    const followUp = `*Order placed* ↪️ ID: ${orderId}`;
                    await this.telegramService.sendMessage(followUp, { parse_mode: 'Markdown' });
                }
            } else {
                logger.error('Telegram not initialize')
            }

            // Success → activate global cooldown to prevent spam
            this.activateExecutionCooldown();

        } catch (err: any) {
            // ────────────────────────────────────────────────────────────────
            // 13. ERROR HANDLING (funds, margin, exchange issues, etc.)
            // ────────────────────────────────────────────────────────────────
            this.handleExecutionError(err, symbol);
            logger.error(`Trade execution failed`, {
                symbol,
                error: err.message || String(err)
            });
        }
    }

    /**
     * Check if we are currently in execution cooldown
     * (after successful trade or funds error)
     */
    private isExecutionCooldownActive(): boolean {
        return Date.now() < this.globalExecutionCooldownUntil;
    }

    /**
     * Activate 10-min cooldown after successful trade or funds error
     */
    private activateExecutionCooldown(): void {
        this.globalExecutionCooldownUntil = Date.now() + this.EXECUTION_COOLDOWN_MS;
        this.consecutiveExecutionErrors = 0;
        logger.info(`Execution cooldown activated for 10 min`, {
            until: new Date(this.globalExecutionCooldownUntil).toISOString()
        });
    }

    /**
     * Handle failed trade attempt (especially funds/margin errors)
     */
    private handleExecutionError(error: any, symbol: string): void {
        const isFundsError =
            error?.message?.toLowerCase().includes('insufficient') ||
            error?.message?.toLowerCase().includes('margin') ||
            error?.code?.includes('INSUFFICIENT') ||
            error?.code?.includes('MARGIN');

        if (!isFundsError) {
            // Non-funds error → just log, no cooldown
            return;
        }

        this.consecutiveExecutionErrors++;
        this.lastExecutionErrorTime = Date.now();

        // Always cooldown on funds error
        this.activateExecutionCooldown();

        logger.warn(`Funds/margin error during execution – cooldown activated`, {
            symbol,
            consecutive: this.consecutiveExecutionErrors,
            error: error?.message || 'unknown'
        });

        // After 3 consecutive → alert & disable
        if (this.consecutiveExecutionErrors >= this.MAX_CONSECUTIVE_EXEC_ERRORS) {
            this.disableAutoTradeAfterErrors();
        }
    }

    /**
     * Disable auto-trade after too many consecutive funds errors
     */
    private disableAutoTradeAfterErrors(): void {
        config.autoTrade.enabled = false;

        const msg = [
            `🚨 AUTO-TRADE DISABLED`,
            `Reason: ${this.consecutiveExecutionErrors} consecutive funds/margin errors`,
            `Last error time: ${new Date(this.lastExecutionErrorTime).toISOString()}`,
            `Manually re-enable in config or restart bot`
        ].join('\n');

        logger.error(msg);

        if (this.telegramService) {
            this.telegramService.sendMessage(msg, { parse_mode: 'Markdown' })
                .catch(err => logger.error('Failed to send disable alert', { err }));
        }

        // Optional: reset counter so it doesn't keep alerting
        this.consecutiveExecutionErrors = 0;
    }

    // Reset method (useful for manual recovery or testing)
    public resetExecutionCooldown(): void {
        this.globalExecutionCooldownUntil = 0;
        this.consecutiveExecutionErrors = 0;
        this.lastExecutionErrorTime = 0;
        logger.info('Execution cooldown & error counter reset');
    }
}
