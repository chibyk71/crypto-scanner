// src/lib/services/telegram/handlers/helpStatus.ts
// handleHelp, handleStatus, handleStopBot

import type TelegramBot from 'node-telegram-bot-api';
import { config } from '../../../config/settings';
import { dbService } from '../../../db';
import { createLogger } from '../../../logger';
import { closeAndCleanUp } from '../../../..';
import type { TelegramContext } from '../context';

const logger = createLogger('TelegramBot');

export async function handleHelp(ctx: TelegramContext, msg: TelegramBot.Message): Promise<void> {
    if (!ctx.isAuthorized(msg.chat.id)) return;

    const helpText = [
        '🤖 *Crypto Scanner Bot — Command Reference*',
        '',
        '*🔧 Alert Management*',
        '• `/alerts` — List all active custom alerts (paginated)',
        '• `/watchlist` — Active watch alerts + condition progress',
        '• `/watch` — How to paste an LLM watch-alert rule set',
        '• `/create_alert` — Step-by-step wizard to create a new alert',
        '• `/edit_alert` — Modify an existing alert',
        '• `/delete_alert` — Delete an alert (with confirmation)',
        '',
        '*📊 Monitoring & Analytics*',
        '• `/status` — Bot health, lock, heartbeat, balance, and exchange status',
        '• `/positions` — View current open positions',
        '• `/trades` — Recent closed trades (last 24 hours)',
        '• `/excursions [symbol]` — Show MAE/MFE excursion stats for a symbol',
        '',
        '*🧠 Machine Learning Controls*',
        '• `/ml_status` — Model training status and sample count',
        '• `/ml_pause` — Temporarily pause ML training',
        '• `/ml_resume` — Resume ML training',
        '• `/ml_train` — Force immediate model retraining',
        '• `/ml_samples` — Training sample breakdown by symbol',
        '• `/ml_performance` — Overall strategy performance metrics',
        // Inside the helpText array in handleHelp():
        '• `/ml_reload` — Load newly uploaded model.onnx without restarting',
        '• `/export_training_data` — Download labeled simulations as CSV for local training',
        '',
        '*⚙️ System Control*',
        '• `/stopbot` — Emergency shutdown (releases lock, clears state)',
        '',
        '*ℹ️ Help*',
        '• `/start` or `/help` — Show this message',
        '',
        '👤 Only authorized administrators can use these commands.',
        '💡 Tip: Use inline keyboards during workflows for the best experience!',
    ].join('\n');

    await ctx.bot.sendMessage(msg.chat.id, helpText, { parse_mode: 'Markdown' });
}

/**
 * Handles the /status command.
 *
 * Provides a comprehensive real-time health report including:
 *   • Worker lock status
 *   • Last heartbeat timestamp
 *   • Exchange connection state
 *   • Account balance
 *   • Trading mode indicator
 *
 * @param msg - Incoming Telegram message
 */
export async function handleStatus(ctx: TelegramContext, msg: TelegramBot.Message): Promise<void> {
    if (!ctx.isAuthorized(msg.chat.id)) return;

    try {
        const lockStatus = await dbService.getLock();
        const heartbeatData = await dbService.getHeartbeatCount();
        const balance = await ctx.exchange.getAccountBalance();
        const isLive = config.autoTrade.enabled;

        const lastHeartbeat = heartbeatData
            ? new Date(heartbeatData).toLocaleString()
            : 'Never';

        const statusLines = [
            '*📊 Bot Status Report*',
            '',
            `*Mode:* ${isLive ? '🟢 **LIVE TRADING**' : '🔵 Testnet / Paper Mode'}`,
            `*Worker:* ${lockStatus ? '🔒 Running (Locked)' : '🟢 Idle (Unlocked)'}`,
            `*Last Heartbeat:* ${lastHeartbeat}`,
            `*Exchange:* ${ctx.exchange.isInitialized() ? '✅ Connected' : '❌ Disconnected'}`,
            `*Balance:* $${balance?.toFixed(2) ?? 'N/A'} USDT`,
            '',
            '✅ All systems nominal',
        ];

        await ctx.bot.sendMessage(msg.chat.id, statusLines.join('\n'), { parse_mode: 'Markdown' });
    } catch (error: any) {
        logger.error('Error generating status report', { error });

        await ctx.bot.sendMessage(
            msg.chat.id,
            '❌ Unable to retrieve full status.\n\nSome services may be unavailable. Check logs for details.'
        );
    }
}

export async function handleStopBot(ctx: TelegramContext, msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;
    if (!ctx.isAuthorized(chatId)) return;

    logger.warn('Stopbot command received', { user: msg.from?.username || msg.from?.id });

    try {
        // 1. Stop polling immediately
        // closeAndCleanUp is a Promise that resolves to the actual cleanup function; await it first, then call it.
        const cleanupFn = await closeAndCleanUp;
        if (typeof cleanupFn === 'function') {
            await cleanupFn();
        } else {
            logger.warn('closeAndCleanUp did not return a callable cleanup function');
        }

        // 3. Clear all user states from memory
        const clearedCount = ctx.userStates.size;
        ctx.userStates.clear();
        logger.info(`Cleared ${clearedCount} user states from memory`);
    } catch (error) {
        logger.error('Unexpected error in /stopbot handler', { error });
        await ctx.bot.sendMessage(chatId, 'Error during shutdown. Check logs.');
    }
}
