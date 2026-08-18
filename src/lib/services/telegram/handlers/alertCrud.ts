// src/lib/services/telegram/handlers/alertCrud.ts
// handleAlerts, handleCreateAlertStart, handleEditAlertStart, handleDeleteAlertStart

import type TelegramBot from 'node-telegram-bot-api';
import { createLogger } from '../../../logger';
import type { TelegramContext } from '../context';
import { sendAlertsList, sendEditAlertSelection, sendDeleteAlertSelection } from '../menus/listMenus';
import { sendSymbolSelection } from '../menus/alertWizardMenus';

const logger = createLogger('TelegramBot');

/**
 * Handles the /alerts command.
 *
 * Initiates the paginated view of all active custom alerts.
 * Sets workflow state and jumps directly to the list.
 *
 * @param msg - Incoming Telegram message
 */
export async function handleAlerts(ctx: TelegramContext, msg: TelegramBot.Message): Promise<void> {
    if (!ctx.isAuthorized(msg.chat.id)) return;

    const chatId = msg.chat.id;

    // Set state for consistent pagination handling
    ctx.updateUserState(chatId, {
        mode: 'alerts',
        step: 'view_alerts',
        page: 0,
        lastActivity: Date.now(),
    });

    await sendAlertsList(ctx, chatId, 0);
}

/**
 * Handles the /create_alert command.
 *
 * Starts the multi-step alert creation wizard:
 *   1. Symbol selection
 *   2. Timeframe
 *   3. Conditions
 *
 * Validates exchange readiness before beginning.
 *
 * @param msg - Incoming Telegram message
 */
export async function handleCreateAlertStart(ctx: TelegramContext, msg: TelegramBot.Message): Promise<void> {
    if (!ctx.isAuthorized(msg.chat.id)) return;

    const chatId = msg.chat.id;

    try {
        const symbols = Array.from(ctx.exchange.getSupportedSymbols());

        if (symbols.length === 0) {
            await ctx.bot.sendMessage(
                chatId,
                '❌ Cannot start alert creation.\n\nExchange connection not ready or no trading pairs available.'
            );
            return;
        }

        // Initialize clean state for creation workflow
        ctx.updateUserState(chatId, {
            mode: 'create',
            step: 'select_symbol',
            data: { symbol: '', timeframe: '', conditions: [] },
            page: 0,
            lastActivity: Date.now(),
        });

        await ctx.bot.sendMessage(chatId, '🔔 *Create New Custom Alert*\n\nLet\'s begin! First, choose a trading pair:', {
            parse_mode: 'Markdown',
        });

        await sendSymbolSelection(ctx, chatId, 0);
    } catch (error: any) {
        logger.error('Failed to initiate alert creation', { error, chatId });
        await ctx.bot.sendMessage(
            chatId,
            '❌ Unable to start alert creation.\n\nPlease try again later or check exchange connection.'
        );
    }
}

/**
 * Handles the /edit_alert command.
 *
 * Initiates selection of an existing alert for modification.
 * Sets edit mode state and shows paginated selection menu.
 *
 * @param msg - Incoming Telegram message
 */
export async function handleEditAlertStart(ctx: TelegramContext, msg: TelegramBot.Message): Promise<void> {
    if (!ctx.isAuthorized(msg.chat.id)) return;

    const chatId = msg.chat.id;

    ctx.updateUserState(chatId, {
        mode: 'edit',
        step: 'select_alert',
        page: 0,
        lastActivity: Date.now(),
    });

    await ctx.bot.sendMessage(chatId, '✏️ *Edit Existing Alert*\n\nSelect the alert you want to modify:', {
        parse_mode: 'Markdown',
    });

    await sendEditAlertSelection(ctx, chatId, 0);
}

/**
 * Handles the /delete_alert command.
 *
 * Initiates deletion workflow with confirmation.
 * Shows paginated list with delete buttons.
 *
 * @param msg - Incoming Telegram message
 */
export async function handleDeleteAlertStart(ctx: TelegramContext, msg: TelegramBot.Message): Promise<void> {
    if (!ctx.isAuthorized(msg.chat.id)) return;

    const chatId = msg.chat.id;

    ctx.updateUserState(chatId, {
        mode: 'delete',
        step: 'delete_alert',
        page: 0,
        lastActivity: Date.now(),
    });

    await ctx.bot.sendMessage(
        chatId,
        '🗑️ *Delete Alert*\n\n⚠️ This action is permanent and cannot be undone.\n\nSelect an alert to remove:',
        { parse_mode: 'Markdown' }
    );

    await sendDeleteAlertSelection(ctx, chatId, 0);
}
