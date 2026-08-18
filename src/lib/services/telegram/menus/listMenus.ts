// src/lib/services/telegram/menus/listMenus.ts
// sendAlertsList, sendEditAlertSelection, sendDeleteAlertSelection,
// sendPositionsList, sendTradesList

import type TelegramBot from 'node-telegram-bot-api';
import { dbService } from '../../../db';
import type { TelegramContext } from '../context';
import { PAGE_SIZE } from '../types';
import { createLogger } from '../../../logger';

const logger = createLogger('TelegramBot');

export async function sendAlertsList(ctx: TelegramContext, chatId: number, page: number = 0): Promise<void> {
    try {
        const allAlerts = await dbService.getActiveAlerts();

        if (allAlerts.length === 0) {
            await ctx.bot.sendMessage(
                chatId,
                'ℹ️ *No active custom alerts*\n\nUse `/create_alert` to set up your first alert.',
                { parse_mode: 'Markdown' }
            );
            return;
        }

        const totalPages = Math.ceil(allAlerts.length / PAGE_SIZE);
        const start = page * PAGE_SIZE;
        const end = Math.min(start + PAGE_SIZE, allAlerts.length);
        const pageAlerts = allAlerts.slice(start, end);

        const alertSummaries = pageAlerts.map((alert: any) => {
            const conditions = alert.conditions
                .map((c: any) => {
                    const period = c.period ? `(${c.period})` : '';
                    const target = Array.isArray(c.target)
                        ? c.target.join('–')
                        : c.target ?? '(any)';

                    return `${c.indicator.toUpperCase()}${period} ${c.operator.replace(/_/g, ' ')} ${target}`;
                })
                .join(' AND ');

            const lastTriggered = alert.lastAlertAt
                ? new Date(alert.lastAlertAt).toLocaleString()
                : 'Never';

            return [
                `**ID:** \`${alert.id}\` • **${alert.symbol}** • \`${alert.timeframe.toUpperCase()}\``,
                `**Conditions:** ${conditions}`,
                `**Last Triggered:** ${lastTriggered}`,
            ].join('\n');
        });

        // Navigation row
        const navigationRow: TelegramBot.InlineKeyboardButton[] = [];
        if (page > 0) {
            navigationRow.push({
                text: '⬅️ Previous',
                callback_data: `alerts_page:${page - 1}`
            });
        }
        if (end < allAlerts.length) {
            navigationRow.push({
                text: 'Next ➡️',
                callback_data: `alerts_page:${page + 1}`
            });
        }

        const message = [
            `**Active Custom Alerts** 🔔`,
            `Page ${page + 1} of ${totalPages}`,
            '',
            ...alertSummaries
        ].join('\n\n');

        await ctx.bot.sendMessage(chatId, message, {
            parse_mode: 'Markdown',
            reply_markup: navigationRow.length > 0
                ? { inline_keyboard: [navigationRow] }
                : undefined,
        });
    } catch (error: any) {
        logger.error('Error listing active alerts', { error });
        await ctx.bot.sendMessage(chatId, '❌ Failed to retrieve alerts. Please try again later.');
    }
}

/**
 * Sends a paginated selection menu for editing an existing alert.
 *
 * @param chatId - Target Telegram chat ID
 * @param page - Current page (0-based)
 * @private
 */
export async function sendEditAlertSelection(ctx: TelegramContext, chatId: number, page: number = 0): Promise<void> {
    try {
        const alerts = await dbService.getActiveAlerts();

        if (alerts.length === 0) {
            await ctx.bot.sendMessage(chatId, 'ℹ️ No active alerts available to edit.');
            return;
        }

        const totalPages = Math.ceil(alerts.length / PAGE_SIZE);
        const start = page * PAGE_SIZE;
        const end = Math.min(start + PAGE_SIZE, alerts.length);
        const pageAlerts = alerts.slice(start, end);

        const inlineKeyboard: TelegramBot.InlineKeyboardButton[][] = pageAlerts.map(alert => [
            {
                text: `#${alert.id} • ${alert.symbol} • ${alert.timeframe.toUpperCase()}`,
                callback_data: `alert_edit_select:${alert.id}`
            }
        ]);

        // Pagination
        const navigationRow: TelegramBot.InlineKeyboardButton[] = [];
        if (page > 0) {
            navigationRow.push({ text: '⬅️ Previous', callback_data: `edit_alerts_page:${page - 1}` });
        }
        if (end < alerts.length) {
            navigationRow.push({ text: 'Next ➡️', callback_data: `edit_alerts_page:${page + 1}` });
        }
        if (navigationRow.length > 0) {
            inlineKeyboard.push(navigationRow);
        }

        await ctx.bot.sendMessage(
            chatId,
            `**Select Alert to Edit** ✏️\nPage ${page + 1}/${totalPages}`,
            {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: inlineKeyboard },
            }
        );
    } catch (error: any) {
        logger.error('Error loading alerts for edit', { error });
        await ctx.bot.sendMessage(chatId, '❌ Failed to load alerts for editing.');
    }
}

/**
 * Sends a paginated selection menu for deleting an alert (with confirmation step).
 *
 * @param chatId - Target Telegram chat ID
 * @param page - Current page (0-based)
 * @private
 */
export async function sendDeleteAlertSelection(ctx: TelegramContext, chatId: number, page: number = 0): Promise<void> {
    try {
        const alerts = await dbService.getActiveAlerts();

        if (alerts.length === 0) {
            await ctx.bot.sendMessage(chatId, 'ℹ️ No active alerts available to delete.');
            return;
        }

        const totalPages = Math.ceil(alerts.length / PAGE_SIZE);
        const start = page * PAGE_SIZE;
        const end = Math.min(start + PAGE_SIZE, alerts.length);
        const pageAlerts = alerts.slice(start, end);

        const inlineKeyboard: TelegramBot.InlineKeyboardButton[][] = pageAlerts.map(alert => [
            {
                text: `🗑️ #${alert.id} • ${alert.symbol} • ${alert.timeframe.toUpperCase()}`,
                callback_data: `alert_delete_confirm:${alert.id}`
            }
        ]);

        // Pagination
        const navigationRow: TelegramBot.InlineKeyboardButton[] = [];
        if (page > 0) {
            navigationRow.push({ text: '⬅️ Previous', callback_data: `delete_alerts_page:${page - 1}` });
        }
        if (end < alerts.length) {
            navigationRow.push({ text: 'Next ➡️', callback_data: `delete_alerts_page:${page + 1}` });
        }
        if (navigationRow.length > 0) {
            inlineKeyboard.push(navigationRow);
        }

        await ctx.bot.sendMessage(
            chatId,
            `**Select Alert to Delete** 🗑️\nPage ${page + 1}/${totalPages}\n\n⚠️ This action cannot be undone.`,
            {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: inlineKeyboard },
            }
        );
    } catch (error: any) {
        logger.error('Error loading alerts for deletion', { error });
        await ctx.bot.sendMessage(chatId, '❌ Failed to load alerts for deletion.');
    }
}

/**
 * Sends a paginated list of currently open positions.
 *
 * Features:
 *   • Clean, structured formatting with key metrics
 *   • Page counter and responsive navigation
 *   • Handles empty states and exchange errors gracefully
 *   • Optimized for readability on mobile
 *
 * @param chatId - Target Telegram chat ID
 * @param page - Current page (0-based)
 * @private
 */
export async function sendPositionsList(ctx: TelegramContext, chatId: number, page: number = 0): Promise<void> {
    try {
        const symbols = ctx.exchange.getSupportedSymbols();

        if (symbols.length === 0) {
            await ctx.bot.sendMessage(chatId, '❌ No trading pairs available. Exchange may not be initialized.');
            return;
        }

        // Fetch all positions across symbols
        const allPositions: { symbol: string; position: any }[] = [];
        for (const symbol of symbols) {
            try {
                const positions = await ctx.exchange.getPositions(symbol);
                positions.forEach(p => allPositions.push({ symbol, position: p }));
            } catch (err) {
                logger.warn(`Failed to fetch positions for ${symbol}`, { error: err });
                // Continue with others
            }
        }

        if (allPositions.length === 0) {
            await ctx.bot.sendMessage(chatId, 'ℹ️ *No open positions currently.*\n\nAll clear! 📈', { parse_mode: 'Markdown' });
            return;
        }

        const totalPages = Math.ceil(allPositions.length / PAGE_SIZE);
        const start = page * PAGE_SIZE;
        const end = Math.min(start + PAGE_SIZE, allPositions.length);
        const pagePositions = allPositions.slice(start, end);

        const positionSummaries = pagePositions.map(({ symbol, position }) => {
            const side = position.side === 'long' ? 'LONG 🟢' : 'SHORT 🔴';
            const contracts = position.contracts ?? 0;
            const entryPrice = position.entryPrice?.toFixed(8) ?? 'N/A';
            const unrealizedPnl = (position.unrealizedPnl ?? 0).toFixed(2);
            const pnlColor = parseFloat(unrealizedPnl) >= 0 ? '🟢' : '🔴';

            return [
                `**${symbol}** • ${side}`,
                `   Contracts: ${contracts}`,
                `   Entry: $${entryPrice}`,
                `   Unrealized PnL: ${pnlColor} ${unrealizedPnl} USDT`,
            ].join('\n');
        });

        // Navigation row
        const navigationRow: TelegramBot.InlineKeyboardButton[] = [];
        if (page > 0) {
            navigationRow.push({ text: '⬅️ Previous', callback_data: `positions_page:${page - 1}` });
        }
        if (end < allPositions.length) {
            navigationRow.push({ text: 'Next ➡️', callback_data: `positions_page:${page + 1}` });
        }

        const message = [
            `**Open Positions** 📈`,
            `Page ${page + 1} of ${totalPages} • Total: ${allPositions.length}`,
            '',
            ...positionSummaries
        ].join('\n\n');

        await ctx.bot.sendMessage(chatId, message, {
            parse_mode: 'Markdown',
            reply_markup: navigationRow.length > 0
                ? { inline_keyboard: [navigationRow] }
                : undefined,
        });
    } catch (error: any) {
        logger.error('Error fetching open positions', { error });
        await ctx.bot.sendMessage(chatId, '❌ Failed to retrieve positions. Exchange may be temporarily unavailable.');
    }
}

/**
 * Sends a paginated list of recently closed trades (last 24 hours).
 *
 * Features:
 *   • Shows profit/loss with color indicators
 *   • Human-readable timestamps
 *   • Handles partial failures per symbol
 *   • Clear empty state
 *
 * @param chatId - Target Telegram chat ID
 * @param page - Current page (0-based)
 * @private
 */
export async function sendTradesList(ctx: TelegramContext, chatId: number, page: number = 0): Promise<void> {
    try {
        const symbols = ctx.exchange.getSupportedSymbols();

        if (symbols.length === 0) {
            await ctx.bot.sendMessage(chatId, '❌ No trading pairs available.');
            return;
        }

        const since = Date.now() - 24 * 60 * 60 * 1000; // Last 24 hours
        const allTrades: { symbol: string; trade: any }[] = [];

        for (const symbol of symbols) {
            try {
                const trades = await ctx.exchange.getClosedTrades(symbol, since);
                trades.forEach(t => allTrades.push({ symbol, trade: t }));
            } catch (err) {
                logger.warn(`Failed to fetch closed trades for ${symbol}`, { error: err });
            }
        }

        if (allTrades.length === 0) {
            await ctx.bot.sendMessage(chatId, 'ℹ️ *No closed trades in the last 24 hours.*\n\nQuiet market or no activity.', { parse_mode: 'Markdown' });
            return;
        }

        // Sort newest first
        allTrades.sort((a, b) => (b.trade.timestamp || b.trade.datetime || 0) - (a.trade.timestamp || a.trade.datetime || 0));

        const totalPages = Math.ceil(allTrades.length / PAGE_SIZE);
        const start = page * PAGE_SIZE;
        const end = Math.min(start + PAGE_SIZE, allTrades.length);
        const pageTrades = allTrades.slice(start, end);

        const tradeSummaries = pageTrades.map(({ symbol, trade }) => {
            const side = trade.side === 'buy' ? 'BUY 🟢' : 'SELL 🔴';
            const amount = (trade.amount ?? 0).toFixed(6);
            const price = trade.price?.toFixed(8) ?? 'N/A';
            const profit = (trade.info?.realized_pnl ?? trade.realizedPnl ?? 0);
            const profitStr = profit.toFixed(2);
            const pnlColor = profit >= 0 ? '🟢' : '🔴';
            const timestamp = trade.datetime
                ? new Date(trade.datetime).toLocaleString()
                : trade.timestamp
                    ? new Date(trade.timestamp).toLocaleString()
                    : 'Unknown';

            return [
                `**${symbol}** • ${side}`,
                `   Amount: ${amount}`,
                `   Price: $${price}`,
                `   Profit: ${pnlColor} ${profitStr} USDT`,
                `   Time: ${timestamp}`,
            ].join('\n');
        });

        // Navigation
        const navigationRow: TelegramBot.InlineKeyboardButton[] = [];
        if (page > 0) {
            navigationRow.push({ text: '⬅️ Previous', callback_data: `trades_page:${page - 1}` });
        }
        if (end < allTrades.length) {
            navigationRow.push({ text: 'Next ➡️', callback_data: `trades_page:${page + 1}` });
        }

        const message = [
            `**Recent Closed Trades** 📉`,
            `Last 24 hours • Page ${page + 1} of ${totalPages} • Total: ${allTrades.length}`,
            '',
            ...tradeSummaries
        ].join('\n\n');

        await ctx.bot.sendMessage(chatId, message, {
            parse_mode: 'Markdown',
            reply_markup: navigationRow.length > 0
                ? { inline_keyboard: [navigationRow] }
                : undefined,
        });
    } catch (error: any) {
        logger.error('Error fetching closed trades', { error });
        await ctx.bot.sendMessage(chatId, '❌ Failed to retrieve trade history. Exchange may be unavailable.');
    }
}

/**
 * Handles the /start and /help commands.
 *
 * Displays a comprehensive, up-to-date command reference with:
 *   • Clear categories
 *   • Emojis for visual hierarchy
 *   • Accurate descriptions
 *   • Professional formatting
 *
 * This is the primary onboarding and reference point for users.
 *
 * @param msg - Incoming Telegram message
 * @private
 */
