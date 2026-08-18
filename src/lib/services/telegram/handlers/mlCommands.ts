// src/lib/services/telegram/handlers/mlCommands.ts
// handleMLStatus, handleMLReload, handleExportTrainingData,
// handleMLPause, handleMLResume, handleMLForceTrain, handleMLSamples, handleMLPerformance

import type TelegramBot from 'node-telegram-bot-api';
import { dbService } from '../../../db';
import { createLogger } from '../../../logger';
import type { TelegramContext } from '../context';

const logger = createLogger('TelegramBot');

export async function handleMLStatus(ctx: TelegramContext, msg: TelegramBot.Message): Promise<void> {
    if (!ctx.isAuthorized(msg.chat.id)) return;

    const chatId = msg.chat.id;

    try {
        const status = await ctx.mlService.getStatus();

        await ctx.bot.sendMessage(
            chatId,
            `**🤖 Machine Learning Status**\n\n${status}`,
            { parse_mode: 'Markdown' }
        );
    } catch (error: any) {
        logger.error('Failed to retrieve ML status', { error, chatId });
        await ctx.bot.sendMessage(chatId, '❌ Unable to fetch ML status at this time.');
    }
};

/**
 * Handles the /takenstats command.
 * Displays statistics for simulations marked as `was_taken = true`.
 *
 * Usage:
 *   /takenstats                → overall stats across all symbols
 *   /takenstats BTC/USDT       → stats filtered to a specific symbol
 */
export async function handleMLReload(ctx: TelegramContext, msg: TelegramBot.Message): Promise<void> {
    if (!ctx.isAuthorized(msg.chat.id)) return;

    const chatId = msg.chat.id;

    try {
        await ctx.bot.sendMessage(chatId, '🔄 Reloading ONNX model from disk...');

        const result = await ctx.mlService.reloadModel();

        await ctx.bot.sendMessage(chatId, result);

        logger.info('ML model reloaded via Telegram command', { chatId });
    } catch (err: any) {
        logger.error('Failed to reload ML model', { error: err.message });
        await ctx.bot.sendMessage(chatId, '❌ Model reload failed. Check server logs.');
    }
};

/**
 * Handles /export_training_data command.
 * Queries all labeled simulations, builds a CSV in memory,
 * and sends it as a file attachment in Telegram.
 *
 * The user downloads this file and drops it in ml/data/training_export.csv
 * before running ml/train.py locally.
 */
export async function handleExportTrainingData(ctx: TelegramContext, msg: TelegramBot.Message): Promise<void> {
    if (!ctx.isAuthorized(msg.chat.id)) return;

    const chatId = msg.chat.id;

    try {
        await ctx.bot.sendMessage(chatId, '⏳ Exporting training data...');

        const rows = await dbService.getExportableSimulations();

        if (rows.length === 0) {
            await ctx.bot.sendMessage(
                chatId,
                'ℹ️ No labeled simulations found yet.\n' +
                'The bot needs to run simulations and label them before export is possible.'
            );
            return;
        }

        // ── Build CSV in memory ───────────────────────────────────────────────
        // Header must match exactly what ml/utils.py expects
        const header = 'symbol,side,label,outcome,closed_at,features';

        const csvRows = rows.map(row => {
            // Escape the features JSON string for CSV:
            //   • wrap in double quotes
            //   • escape any existing double quotes by doubling them
            const escapedFeatures = `"${row.features.replace(/"/g, '""')}"`;

            return [
                row.symbol,
                row.side,
                row.label,
                row.outcome ?? '',
                row.closedAt ?? '',
                escapedFeatures,
            ].join(',');
        });

        const csv = [header, ...csvRows].join('\n');

        // ── Send as file attachment ───────────────────────────────────────────
        // Telegram's sendDocument accepts a Buffer with a filename
        // No temp file needed — stays in memory
        const buffer = Buffer.from(csv, 'utf-8');
        const filename = `training_export_${Date.now()}.csv`;

        await ctx.bot.sendDocument(
            chatId,
            buffer,
            {
                caption:
                    `✅ ${rows.length} labeled simulations exported.\n` +
                    `Drop this file in ml/data/training_export.csv then run ml/train.py`,
            },
            {
                filename,
                contentType: 'text/csv',
            }
        );

        logger.info('Training data exported via Telegram', {
            chatId,
            rowCount: rows.length,
            filename,
        });

    } catch (err: any) {
        logger.error('Failed to export training data', {
            error: err.message,
            stack: err.stack,
        });
        await ctx.bot.sendMessage(
            chatId,
            '❌ Export failed. Check server logs for details.'
        );
    }
};

/**
 * Handles the /takensymbols command.
 * Displays the top symbols ranked by number of taken (filtered/executed) simulations.
 *
 * Usage examples:
 *   /takensymbols          → shows top 10 symbols
 *   /takensymbols 5        → shows top 5 symbols
 *   /takensymbols 20       → shows top 20 symbols (clamped between 3–30)
 */
export async function handleMLPause(ctx: TelegramContext, msg: TelegramBot.Message): Promise<void> {
    if (!ctx.isAuthorized(msg.chat.id)) return;

    const chatId = msg.chat.id;
    const username = msg.from?.username || msg.from?.first_name || 'unknown';

    try {
        ctx.mlService.pauseTraining();

        await ctx.bot.sendMessage(chatId, '⏸️ *ML training has been paused.*\n\nNew samples will be collected but no retraining will occur until resumed.');
        logger.info('ML training paused by user', { username, chatId });
    } catch (error: any) {
        logger.error('Error pausing ML training', { error, username });
        await ctx.bot.sendMessage(chatId, '❌ Failed to pause ML training.');
    }
};

/**
 * Handles the /ml_resume command.
 *
 * Resumes paused ML model training.
 *
 * @param msg - Incoming Telegram message
 * @private
 */
export async function handleMLResume(ctx: TelegramContext, msg: TelegramBot.Message): Promise<void> {
    if (!ctx.isAuthorized(msg.chat.id)) return;

    const chatId = msg.chat.id;
    const username = msg.from?.username || msg.from?.first_name || 'unknown';

    try {
        ctx.mlService.resumeTraining();

        await ctx.bot.sendMessage(chatId, '▶️ *ML training has been resumed.*\n\nRetraining will occur automatically when sufficient new samples are available.');
        logger.info('ML training resumed by user', { username, chatId });
    } catch (error: any) {
        logger.error('Error resuming ML training', { error, username });
        await ctx.bot.sendMessage(chatId, '❌ Failed to resume ML training.');
    }
};

/**
 * Handles the /ml_train command.
 *
 * Forces an immediate retraining of the ML model regardless of sample threshold.
 *
 * @param msg - Incoming Telegram message
 * @private
 */
export async function handleMLForceTrain(ctx: TelegramContext, msg: TelegramBot.Message): Promise<void> {
    if (!ctx.isAuthorized(msg.chat.id)) return;

    const chatId = msg.chat.id;
    const username = msg.from?.username || msg.from?.first_name || 'unknown';

    try {
        await ctx.bot.sendMessage(chatId, '🔄 *Forcing ML model retraining...*\n\nThis may take 30\\-90 seconds depending on sample count.');

        await ctx.mlService.forceRetrain();

        await ctx.bot.sendMessage(chatId, '✅ *ML model retraining completed successfully!*');
        logger.info('Forced ML retraining completed', { username, chatId });
    } catch (error: any) {
        logger.error('Error during forced ML training', { error, username });
        await ctx.bot.sendMessage(chatId, '❌ Failed to complete forced training.\n\nCheck logs for details.');
    }
};

/**
 * Handles the /ml_samples command.
 *
 * Shows a detailed breakdown of training samples by symbol.
 *
 * @param msg - Incoming Telegram message
 * @private
 */
export async function handleMLSamples(ctx: TelegramContext, msg: TelegramBot.Message): Promise<void> {
    if (!ctx.isAuthorized(msg.chat.id)) return;

    const chatId = msg.chat.id;

    try {
        const summary = await ctx.mlService.getSampleSummary();

        await ctx.bot.sendMessage(
            chatId,
            `**📈 Training Sample Summary**\n\n${summary}`,
            { parse_mode: 'Markdown' }
        );
    } catch (error: any) {
        logger.error('Error fetching training sample summary', { error, chatId });
        await ctx.bot.sendMessage(chatId, '❌ Unable to retrieve sample summary.');
    }
};

/**
 * Handles the /ml_performance command.
 *
 * Displays overall strategy performance metrics derived from simulations.
 *
 * @param msg - Incoming Telegram message
 * @private
 */
export async function handleMLPerformance(ctx: TelegramContext, msg: TelegramBot.Message): Promise<void> {
    if (!ctx.isAuthorized(msg.chat.id)) return;

    const chatId = msg.chat.id;

    try {
        const metrics = await ctx.mlService.getPerformanceMetrics();

        await ctx.bot.sendMessage(
            chatId,
            `**📊 Strategy Performance Metrics**\n\n${metrics}`,
            { parse_mode: 'Markdown' }
        );
    } catch (error: any) {
        logger.error('Error fetching performance metrics', { error, chatId });
        await ctx.bot.sendMessage(chatId, '❌ Unable to retrieve performance metrics.');
    }
};

/**
 * Handles the /positions command.
 * - Initiates paginated position listing.
 * @param msg - Incoming Telegram message.
 * @private
 */
