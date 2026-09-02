// src/lib/services/telegram/handlers/positionsTrades.ts
// handlePositions, handleTrades

import type TelegramBot from 'node-telegram-bot-api';

import type { TelegramContext } from '../context';
import { sendPositionsList, sendTradesList } from '../menus/listMenus';

export async function handlePositions(ctx: TelegramContext, msg: TelegramBot.Message): Promise<void> {
    if (!ctx.isAuthorized(msg.chat.id)) return;
    ctx.updateUserState(msg.chat.id, { mode: 'positions', step: 'view_positions', page: 0 });
    await sendPositionsList(ctx, msg.chat.id, 0);
}

/**
 * Handles the /trades command.
 * - Initiates paginated trade listing.
 * @param msg - Incoming Telegram message.
 */
export async function handleTrades(ctx: TelegramContext, msg: TelegramBot.Message): Promise<void> {
    if (!ctx.isAuthorized(msg.chat.id)) return;
    ctx.updateUserState(msg.chat.id, { mode: 'trades', step: 'view_trades', page: 0 });
    await sendTradesList(ctx, msg.chat.id, 0);
}
