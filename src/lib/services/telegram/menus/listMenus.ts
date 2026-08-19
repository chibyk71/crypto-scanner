// src/lib/services/telegram/menus/listMenus.ts
// sendAlertsList, sendEditAlertSelection, sendDeleteAlertSelection,
// sendPositionsList, sendTradesList

import type TelegramBot from 'node-telegram-bot-api';
import type { TelegramContext } from '../context';
import { PAGE_SIZE } from '../types';
import { createLogger } from '../../../logger';

const logger = createLogger('TelegramBot');

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
