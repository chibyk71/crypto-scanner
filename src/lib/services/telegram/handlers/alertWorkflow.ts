// src/lib/services/telegram/handlers/alertWorkflow.ts
// handleMessage + handleCallbackQuery — KEEP TOGETHER (shared AlertState step machine)
// Steps: select_symbol → select_timeframe → conditions_menu → select_indicator →
//        enter_period → select_operator → select_target

import type TelegramBot from 'node-telegram-bot-api';
import { dbService } from '../../../db';
import { createLogger } from '../../../logger';
import type { Condition } from '../../../../types';
import type { TelegramContext } from '../context';
import type { AlertState } from '../types';
import {
    sendSymbolSelection,
    sendTimeframeSelection,
    sendIndicatorSelection,
    sendOperatorSelection,
    sendConditionsMenu,
} from '../menus/alertWizardMenus';
import {
    sendAlertsList,
    sendEditAlertSelection,
    sendDeleteAlertSelection,
    sendPositionsList,
    sendTradesList,
} from '../menus/listMenus';

const logger = createLogger('TelegramBot');

export async function handleMessage(ctx: TelegramContext, msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;

    // Security check
    if (!ctx.isAuthorized(chatId)) {
        await ctx.sendMessage(
            'Unauthorized access. This bot only responds to messages from its configured primary chat ID.'
        );
        return;
    }

    // Only process text messages in active workflow states
    const state = ctx.userStates.get(chatId);
    if (!state || !msg.text) return;

    const text = msg.text.trim();

    try {
        // === STEP: Entering period for indicators (e.g., RSI(14)) ===
        if (state.step === 'enter_period') {
            const period = parseInt(text, 10);

            if (isNaN(period) || period < 1 || period > 500) {
                await ctx.bot.sendMessage(
                    chatId,
                    '❌ Invalid period. Please enter a whole number between 1 and 500 (e.g., 14, 50, 200).'
                );
                return;
            }

            if (state.temp) {
                state.temp.period = period;
            }

            state.step = 'select_operator';
            ctx.updateUserState(chatId, state);

            await sendOperatorSelection(
                chatId,
                state.temp?.indicator as Condition['indicator']
            );
            return;
        }

        // === STEP: Entering target value (number, range, or indicator) ===
        if (state.step === 'select_target') {
            let target: number | string | number[];

            if (state.temp?.operator === 'is_in_range') {
                // Format: "20-80" or "30 - 70"
                const parts = text.split('-').map(p => parseFloat(p.trim()));
                if (parts.length !== 2 || parts.some(isNaN) || parts[0] >= parts[1]) {
                    throw new Error('Invalid range format. Use: min-max (e.g., 20-80)');
                }
                target = parts;
            } else if (['crosses_above', 'crosses_below'].includes(state.temp?.operator || '')) {
                // Allow indicator reference (e.g., "ema_200") or number
                const validIndicators = [
                    'close', 'high', 'low', 'volume',
                    'rsi', 'ema', 'sma', 'macd_line', 'macd_signal',
                    'bb_upper', 'bb_lower'
                ];
                const isValidIndicator = validIndicators.includes(text.toLowerCase()) ||
                    /^ema_\d+$/i.test(text) ||
                    /^sma_\d+$/i.test(text);

                if (isValidIndicator) {
                    target = text.toLowerCase();
                } else {
                    const num = parseFloat(text);
                    if (isNaN(num)) throw new Error('Expected a number or valid indicator (e.g., ema_200)');
                    target = num;
                }
            } else {
                // Standard numeric comparison
                const num = parseFloat(text);
                if (isNaN(num)) throw new Error('Expected a numeric value (e.g., 70)');
                target = num;
            }

            // Save condition and return to menu
            if (state.temp) {
                state.temp.target = target;
                state.data.conditions.push(state.temp as Condition);
            }
            delete state.temp;

            state.step = 'conditions_menu';
            ctx.updateUserState(chatId, state);

            await sendConditionsMenu(chatId, state.data);
            return;
        }

        // If we reach here: message not expected in current step
        await ctx.bot.sendMessage(
            chatId,
            '⚠️ Unexpected input. Use the buttons or follow the current prompt.'
        ).catch((e) => {
            logger.error('', { error: e })
        });
    } catch (error: any) {
        logger.warn('Invalid input in alert workflow', {
            chatId,
            step: state.step,
            input: text,
            error: error.message,
        });

        await ctx.bot.sendMessage(
            chatId,
            `❌ ${error.message || 'Invalid input. Please try again.'}`
        );
    }
};

/**
 * Handles the /stopbot command.
 * Stops the Telegram bot, clears all user states, and optionally releases DB lock.
 * Only works in production (when bot is actually running via worker).
 * @param msg - Incoming Telegram message.
 * @private
 */
export async function handleCallbackQuery(ctx: TelegramContext, query: TelegramBot.CallbackQuery): Promise<void> {
    const chatId = query.message?.chat.id ?? query.from.id;

    if (!ctx.isAuthorized(chatId)) {
        await ctx.bot.answerCallbackQuery(query.id, { text: '❌ Unauthorized', show_alert: true });
        return;
    }

    const data = query.data;
    if (!data) {
        await ctx.bot.answerCallbackQuery(query.id);
        return;
    }

    // Load or initialize state
    let state = ctx.userStates.get(chatId);
    if (!state) {
        state = {
            mode: 'create',
            step: '',
            data: { symbol: '', timeframe: '', conditions: [] },
            page: 0,
            lastActivity: Date.now(),
        };
        ctx.userStates.set(chatId, state);
    }
    ctx.updateUserState(chatId, state);

    try {
        // =================================================================
        // Alert Creation Flow
        // =================================================================
        if (data.startsWith('alert_select_symbol:')) {
            state.data.symbol = data.split(':')[1];
            state.step = 'select_timeframe';
            await sendTimeframeSelection(chatId);

        } else if (data.startsWith('alert_next_symbols:')) {
            state.page = parseInt(data.split(':')[1], 10);
            await sendSymbolSelection(chatId, state.page);

        } else if (data.startsWith('alert_select_timeframe:')) {
            state.data.timeframe = data.split(':')[1];
            state.step = 'conditions_menu';
            await sendConditionsMenu(chatId, state.data);

        } else if (data === 'alert_add_condition') {
            state.step = 'select_indicator';
            await sendIndicatorSelection(chatId);

        } else if (data.startsWith('alert_select_indicator:')) {
            const indicator = data.split(':')[1] as Condition['indicator'];
            state.temp = { indicator };

            const needsPeriod = ['rsi', 'ema', 'sma', 'macd_line', 'macd_signal', 'bb_upper', 'bb_lower'].includes(indicator);
            state.step = needsPeriod ? 'enter_period' : 'select_operator';

            if (needsPeriod) {
                await ctx.bot.sendMessage(
                    chatId,
                    `Enter the **Period** for ${indicator.toUpperCase()} (e.g., 14):`,
                    { parse_mode: 'Markdown' }
                );
            } else {
                await sendOperatorSelection(chatId, indicator);
            }

        } else if (data.startsWith('alert_select_operator:')) {
            const operator = data.split(':')[1] as Condition['operator'];
            if (state.temp) state.temp.operator = operator;
            state.step = 'select_target';

            const indicatorName = (state.temp?.indicator || 'Value').toUpperCase();
            let prompt = `Enter value for ${indicatorName} `;

            if (operator === 'is_in_range') {
                prompt += '(format: min-max, e.g., 20-80)';
            } else if (['crosses_above', 'crosses_below'].includes(operator)) {
                prompt += '(number or indicator, e.g., 10000 or ema_200)';
            } else {
                prompt += '(e.g., 70)';
            }

            await ctx.bot.sendMessage(chatId, prompt);

        } else if (data === 'alert_remove_last') {
            if (state.data.conditions.length > 0) {
                state.data.conditions.pop();
            }
            await sendConditionsMenu(chatId, state.data);

        } else if (data === 'alert_save') {
            if (!state.data.symbol || !state.data.timeframe || state.data.conditions.length === 0) {
                await ctx.bot.answerCallbackQuery(query.id, {
                    text: 'Incomplete alert! Add symbol, timeframe, and conditions.',
                    show_alert: true,
                });
                return;
            }

            if (state.mode === 'create') {
                const newId = await dbService.createAlert({
                    symbol: state.data.symbol,
                    timeframe: state.data.timeframe,
                    conditions: state.data.conditions,
                    status: 'active',
                });
                await ctx.bot.sendMessage(chatId, `✅ Alert created successfully! ID: ${newId}`);
            } else if (state.mode === 'edit' && state.alertId) {
                await dbService.updateAlert(Number(state.alertId), state.data);
                await ctx.bot.sendMessage(chatId, `✅ Alert ${state.alertId} updated successfully!`);
            }

            ctx.userStates.delete(chatId);

        } else if (data === 'alert_cancel') {
            ctx.userStates.delete(chatId);
            await ctx.bot.sendMessage(chatId, 'Operation cancelled.');

            // =================================================================
            // Edit / Delete Flows
            // =================================================================
        } else if (data.startsWith('alert_edit_select:')) {
            const alertId = data.split(':')[1];
            const alert = await dbService.getAlertsById(Number(alertId));
            if (!alert) {
                await ctx.bot.sendMessage(chatId, `Alert ${alertId} not found.`);
                return;
            }
            state.mode = 'edit';
            state.alertId = alertId;
            state.data = {
                symbol: alert.symbol,
                timeframe: alert.timeframe,
                conditions: alert.conditions,
            };
            state.step = 'conditions_menu';
            await sendConditionsMenu(chatId, state.data);

        } else if (data.startsWith('alert_delete_confirm:')) {
            const alertId = data.split(':')[1];
            await ctx.bot.sendMessage(chatId, `⚠️ Confirm deletion of alert ${alertId}?`, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Yes, delete', callback_data: `alert_delete_yes:${alertId}` }],
                        [{ text: 'Cancel', callback_data: 'alert_cancel' }],
                    ],
                },
            });

        } else if (data.startsWith('alert_delete_yes:')) {
            const alertId = data.split(':')[1];
            await dbService.deleteAlert(Number(alertId));
            await ctx.bot.sendMessage(chatId, `🗑️ Alert ${alertId} deleted.`);
            ctx.userStates.delete(chatId);

            // =================================================================
            // Pagination
            // =================================================================
        } else if (data.startsWith('alerts_page:')) {
            state.page = parseInt(data.split(':')[1], 10);
            await sendAlertsList(chatId, state.page);

        } else if (data.startsWith('edit_alerts_page:')) {
            state.page = parseInt(data.split(':')[1], 10);
            await sendEditAlertSelection(chatId, state.page);

        } else if (data.startsWith('delete_alerts_page:')) {
            state.page = parseInt(data.split(':')[1], 10);
            await sendDeleteAlertSelection(chatId, state.page);

        } else if (data.startsWith('positions_page:')) {
            state.page = parseInt(data.split(':')[1], 10);
            await sendPositionsList(chatId, state.page);

        } else if (data.startsWith('trades_page:')) {
            state.page = parseInt(data.split(':')[1], 10);
            await sendTradesList(chatId, state.page);
        }

        // Always acknowledge the callback
        await ctx.bot.answerCallbackQuery(query.id);

    } catch (error: any) {
        logger.error('Error in callback query handler', {
            chatId,
            data,
            error: error.message,
            stack: error.stack,
        });

        await ctx.bot.answerCallbackQuery(query.id, {
            text: 'An error occurred. Operation cancelled.',
            show_alert: true,
        });

        ctx.userStates.delete(chatId);
        await ctx.bot.sendMessage(chatId, '❌ Unexpected error. Workflow cancelled.');
    }
};
/**
 * Sends a paginated symbol selection keyboard.
 *
 * Features:
 *   • Alphabetically sorted symbols for easier navigation
 *   • Clear page indicator
 *   • Responsive Next/Previous buttons
 *   • Graceful handling of empty symbol list
 *
 * @param chatId - Target Telegram chat ID
 * @param page - Current page (0-based)
 * @private
 */
