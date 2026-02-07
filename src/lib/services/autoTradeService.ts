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

    public async execute(signal: TradeSignal): Promise<void> {
        const symbol = signal.symbol;

        // 1. Global execution cooldown check
        if (this.isExecutionCooldownActive()) {
            logger.debug('Execution cooldown active – skipping', { symbol });
            return;
        }

        // 2. Minimal guards
        if (!config.autoTrade.enabled) {
            logger.debug('AutoTrade disabled – ignoring', { symbol });
            return;
        }

        const isSupported = await this.exchange.validateSymbol(symbol);
        if (!isSupported) {
            logger.warn(`Symbol not supported – skipping`, { symbol });
            return;
        }

        try {
            const currentPrice = await this.exchange.getLatestPrice(symbol);
            if (!currentPrice || currentPrice <= 0) {
                logger.warn(`Invalid price – aborting`, { symbol });
                return;
            }

            const regime = excursionCache.getRegime(symbol);
            if (!regime || regime.recentSampleCount === 0) {
                logger.warn(`No regime data – skipping`, { symbol });
                return;
            }

            const direction = signal.signal === 'buy' ? 'long' : 'short';
            const advice = getExcursionAdvice(regime, direction);

            if (advice.action === 'skip') {
                logger.info(`Excursion says ${advice.action} – not executing`, { symbol });
                return;
            }

            let finalSide = signal.signal;
            let wasReversed = false;

            if (finalSide === 'hold') {
                return
            }

            if (advice.action === 'reverse') {
                finalSide = signal.signal === 'buy' ? 'sell' : 'buy';
                wasReversed = true;
                logger.info(`Excursion reversed → ${finalSide.toUpperCase()}`, { symbol });
            }

            // Fixed amount from config
            const FIXED_QUOTE_USD = config.autoTrade.fixedTradeUsd ?? 20;
            const amount = FIXED_QUOTE_USD / currentPrice;

            if (amount < 0.0001) {
                logger.warn(`Amount too small – skipping`, { symbol, amount });
                return;
            }

            // Place order
            const order = await this.exchange.placeOrder(
                symbol,
                finalSide,
                amount,
                signal.stopLoss,
                signal.takeProfit,
                signal.trailingStopDistance
            );

            const orderId = order.id || 'unknown';

            // Success → cooldown + reset errors
            this.activateExecutionCooldown();

            // Log & notify
            logger.info(`Trade executed`, {
                symbol,
                side: finalSide.toUpperCase(),
                amount: amount.toFixed(6),
                price: currentPrice.toFixed(8),
                usdValue: FIXED_QUOTE_USD,
                wasReversed,
                advice: advice.advice
            });

            if (this.telegramService) {
                const msg = [
                    `*TRADE OPENED* ${wasReversed ? '↔️ REVERSED' : ''}`,
                    `${finalSide.toUpperCase()} ${symbol}`,
                    `~$${FIXED_QUOTE_USD.toFixed(0)}`,
                    `Entry: $${currentPrice.toFixed(2)}`,
                    `Advice: ${advice.advice}`,
                    `Order ID: ${orderId}`
                ].join('\n');

                await this.telegramService.sendMessage(msg, { parse_mode: 'Markdown' });
            }

        } catch (err: any) {
            this.handleExecutionError(err, symbol);
            logger.error(`Trade failed`, { symbol, error: err.message });
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
