// src/lib/services/telegram/menus/alertWizardMenus.ts
// sendSymbolSelection, sendTimeframeSelection, sendIndicatorSelection,
// sendOperatorSelection, sendConditionsMenu

import type TelegramBot from 'node-telegram-bot-api';
import type { Condition } from '../../../../types';
import type { TelegramContext } from '../context';
import { PAGE_SIZE, type AlertState } from '../types';
// import { createLogger } from '../../../logger';

// const logger = createLogger('TelegramBot');

export async function sendSymbolSelection(ctx: TelegramContext, chatId: number, page: number = 0): Promise<void> {
    let symbols = Array.from(ctx.exchange.getSupportedSymbols());

    if (symbols.length === 0) {
        await ctx.bot.sendMessage(
            chatId,
            '❌ No trading pairs available. Exchange connection may be down or not initialized yet.'
        );
        return;
    }

    // Sort alphabetically for consistent, predictable ordering
    symbols = symbols.sort((a, b) => a.localeCompare(b));

    const totalPages = Math.ceil(symbols.length / PAGE_SIZE);
    const start = page * PAGE_SIZE;
    const end = Math.min(start + PAGE_SIZE, symbols.length);
    const pageSymbols = symbols.slice(start, end);

    const inlineKeyboard: TelegramBot.InlineKeyboardButton[][] = pageSymbols.map(symbol => [
        { text: symbol, callback_data: `alert_select_symbol:${symbol}` }
    ]);

    // Add navigation row if needed
    const navigationRow: TelegramBot.InlineKeyboardButton[] = [];
    if (page > 0) {
        navigationRow.push({ text: '⬅️ Previous', callback_data: `alert_next_symbols:${page - 1}` });
    }
    if (end < symbols.length) {
        navigationRow.push({ text: 'Next ➡️', callback_data: `alert_next_symbols:${page + 1}` });
    }
    if (navigationRow.length > 0) {
        inlineKeyboard.push(navigationRow);
    }

    const message = totalPages > 1
        ? `**Step 1: Select Symbol** (Page ${page + 1}/${totalPages})\n\nChoose a trading pair:`
        : '**Step 1: Select Symbol**\n\nChoose a trading pair:';

    await ctx.bot.sendMessage(chatId, message, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: inlineKeyboard },
    });
}

/**
 * Sends a compact timeframe selection keyboard.
 *
 * Features:
 *   • 2-column layout for better mobile experience
 *   • Clear labels with full names
 *   • Consistent with common crypto timeframes
 *
 * @param chatId - Target Telegram chat ID
 * @private
 */
export async function sendTimeframeSelection(ctx: TelegramContext, chatId: number): Promise<void> {
    const timeframes = [
        { value: '1m', label: '1 Minute' },
        { value: '5m', label: '5 Minutes' },
        { value: '15m', label: '15 Minutes' },
        { value: '30m', label: '30 Minutes' },
        { value: '1h', label: '1 Hour' },
        { value: '4h', label: '4 Hours' },
        { value: '1d', label: '1 Day' },
        { value: '1w', label: '1 Week' },
    ];

    // 2-column grid layout
    const inlineKeyboard: TelegramBot.InlineKeyboardButton[][] = [];
    for (let i = 0; i < timeframes.length; i += 2) {
        const row = [
            { text: timeframes[i].label, callback_data: `alert_select_timeframe:${timeframes[i].value}` }
        ];
        if (i + 1 < timeframes.length) {
            row.push({
                text: timeframes[i + 1].label,
                callback_data: `alert_select_timeframe:${timeframes[i + 1].value}`
            });
        }
        inlineKeyboard.push(row);
    }

    await ctx.bot.sendMessage(chatId, '**Step 2: Select Timeframe**\n\nChoose the candle interval for your alert:', {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: inlineKeyboard },
    });
}

/**
 * Sends an indicator selection keyboard with grouped layout.
 *
 * Features:
 *   • Logical grouping (price, volume, oscillators, bands)
 *   • Clean uppercase labels
 *   • 2–3 column layout for density
 *
 * @param chatId - Target Telegram chat ID
 * @private
 */
export async function sendIndicatorSelection(ctx: TelegramContext, chatId: number): Promise<void> {
    const indicators = [
        // Price & Volume
        { value: 'close', label: 'CLOSE' },
        { value: 'high', label: 'HIGH' },
        { value: 'low', label: 'LOW' },
        { value: 'volume', label: 'VOLUME' },

        // Oscillators & Momentum
        { value: 'rsi', label: 'RSI' },
        { value: 'macd_line', label: 'MACD Line' },
        { value: 'macd_signal', label: 'MACD Signal' },

        // Moving Averages
        { value: 'ema', label: 'EMA' },
        { value: 'sma', label: 'SMA' },

        // Bollinger Bands
        { value: 'bb_upper', label: 'BB Upper' },
        { value: 'bb_lower', label: 'BB Lower' },
    ];

    const inlineKeyboard: TelegramBot.InlineKeyboardButton[][] = [];
    for (let i = 0; i < indicators.length; i += 3) {
        const row: TelegramBot.InlineKeyboardButton[] = [];
        for (let j = 0; j < 3 && i + j < indicators.length; j++) {
            const ind = indicators[i + j];
            row.push({
                text: ind.label,
                callback_data: `alert_select_indicator:${ind.value}`
            });
        }
        inlineKeyboard.push(row);
    }

    await ctx.bot.sendMessage(chatId, '**Choose Indicator**\n\nSelect the technical indicator for your condition:', {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: inlineKeyboard },
    });
}

/**
 * Sends an operator selection keyboard tailored to the chosen indicator.
 *
 * Features:
 *   • Human-readable operator labels (e.g., "Crosses Above" instead of "crosses_above")
 *   • Logical grouping in 3-column layout for faster selection
 *   • Clear prompt with context
 *
 * @param chatId - Target Telegram chat ID
 * @param indicator - The currently selected indicator
 * @private
 */
export async function sendOperatorSelection(ctx: TelegramContext, chatId: number, indicator: Condition['indicator']): Promise<void> {
    // Human-readable mapping for better UX
    const operatorMap: Array<{ value: Condition['operator']; label: string }> = [
        { value: 'crosses_above', label: 'Crosses Above ↗️' },
        { value: 'crosses_below', label: 'Crosses Below ↘️' },
        { value: '>', label: 'Greater Than >' },
        { value: '<', label: 'Less Than <' },
        { value: '>=', label: 'Greater or Equal ≥' },
        { value: '<=', label: 'Less or Equal ≤' },
        { value: 'is_equal', label: 'Equals =' },
        { value: 'is_not_equal', label: 'Not Equal ≠' },
        { value: 'is_in_range', label: 'In Range [min-max]' },
    ];

    // 3-column grid for compact, fast selection
    const inlineKeyboard: TelegramBot.InlineKeyboardButton[][] = [];
    for (let i = 0; i < operatorMap.length; i += 3) {
        const row: TelegramBot.InlineKeyboardButton[] = [];
        for (let j = 0; j < 3 && i + j < operatorMap.length; j++) {
            const op = operatorMap[i + j];
            row.push({
                text: op.label,
                callback_data: `alert_select_operator:${op.value}`
            });
        }
        inlineKeyboard.push(row);
    }

    await ctx.bot.sendMessage(
        chatId,
        `**Choose Operator for ${indicator.toUpperCase()}**\n\nSelect how the indicator should trigger the alert:`,
        {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: inlineKeyboard },
        }
    );
}

/**
 * Sends the main conditions menu with live preview and action buttons.
 *
 * Features:
 *   • Clean, formatted current configuration summary
 *   • Logical condition display with periods and targets
 *   • Dynamic action buttons (only show relevant ones)
 *   • Professional layout with status indicators
 *
 * @param chatId - Target Telegram chat ID
 * @param data - Current alert configuration state
 * @private
 */
export async function sendConditionsMenu(ctx: TelegramContext, chatId: number, data: AlertState['data']): Promise<void> {
    // Build symbol/timeframe header
    const header = data.symbol && data.timeframe
        ? `**${data.symbol}** • ${data.timeframe.toUpperCase()}`
        : 'Not set yet';

    // Format conditions list
    let conditionsText: string;
    if (data.conditions.length === 0) {
        conditionsText = '_No conditions added yet_';
    } else {
        conditionsText = data.conditions
            .map((c, idx) => {
                const period = c.period ? `(${c.period})` : '';
                const target = Array.isArray(c.target)
                    ? c.target.join('–')
                    : c.target ?? '(pending)';

                return `${idx + 1}. ${c.indicator.toUpperCase()}${period} ${c.operator.replace(/_/g, ' ')} ${target}`;
            })
            .join('\n');
    }

    // Build message
    const messageLines = [
        `*Current Alert Configuration* 🔧`,
        '',
        `**Pair:** ${header}`,
        '',
        `**Conditions (${data.conditions.length}):**`,
        '```',
        conditionsText,
        '```',
        '',
        `*Actions:*`,
    ];

    // Dynamic keyboard based on state
    const inlineKeyboard: TelegramBot.InlineKeyboardButton[][] = [
        [{ text: '➕ Add Condition', callback_data: 'alert_add_condition' }]
    ];

    if (data.conditions.length > 0) {
        inlineKeyboard.push([
            { text: '➖ Remove Last', callback_data: 'alert_remove_last' }
        ]);

        // Only show Save if configuration is complete
        if (data.symbol && data.timeframe && data.conditions.length > 0) {
            inlineKeyboard.push([
                { text: '💾 Save Alert', callback_data: 'alert_save' }
            ]);
        }
    }

    inlineKeyboard.push([
        { text: '❌ Cancel', callback_data: 'alert_cancel' }
    ]);

    await ctx.bot.sendMessage(chatId, messageLines.join('\n'), {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: inlineKeyboard },
    });
}

/**
 * Sends a paginated list of all active custom alerts.
 *
 * Features:
 *   • Clear formatting with ID, symbol, timeframe, conditions
 *   • Human-readable last trigger time
 *   • Responsive pagination with page counter
 *   • Empty state handling
 *
 * @param chatId - Target Telegram chat ID
 * @param page - Current page (0-based)
 * @private
 */
