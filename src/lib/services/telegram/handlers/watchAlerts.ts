// src/lib/services/telegram/handlers/watchAlerts.ts
// Watch Alert paste / confirm / cancel / list handlers.
// Every function takes ctx: TelegramContext as first param — no `this`.

import type TelegramBot from 'node-telegram-bot-api';
import { createLogger } from '../../../logger';
import type { TelegramContext } from '../context';
import { escape, formatR } from '../utils/markdown';
import type { WatchAlertService } from '../../watchAlerts';
import type { PendingWatchAlert } from '../../watchAlerts';
import { clampExpiryHours } from '../../watchAlerts/schema';

const logger = createLogger('Telegram.WatchAlerts');

/**
 * /watchlist — list active watch alerts with best-effort leaf progress.
 */
export async function handleWatchlistCommand(
    ctx: TelegramContext,
    msg: TelegramBot.Message
): Promise<void> {
    if (!ctx.isAuthorized(msg.chat.id)) return;

    const service = ctx.watchAlertService;
    if (!service) {
        await ctx.sendMessage('Watch alerts are not available right now.');
        return;
    }

    try {
        const list = await service.listActive();
        if (list.length === 0) {
            await ctx.bot.sendMessage(
                msg.chat.id,
                'No active watch alerts.\n\nPaste a JSON rule-set to create one.'
            );
            return;
        }

        const blocks: string[] = ['*Active Watch Alerts*', ''];
        for (const item of list) {
            const a = item.alert;
            const expiresInH = Math.max(
                0,
                (a.expiresAt - Date.now()) / (60 * 60 * 1000)
            );
            blocks.push(
                `*\\#${escape(a.id)}* \`${escape(a.symbol)}\` \\(${escape(a.confidence)}\\)`,
                escape(a.thesis.slice(0, 120)),
                `Progress: ${escape(item.metCount)}/${escape(item.totalCount)} conditions`,
                `Expires in ~${escape(expiresInH.toFixed(1))}h`,
                ''
            );
            for (const leaf of item.leaves.slice(0, 6)) {
                const mark = leaf.met ? '✅' : '⬜';
                blocks.push(`${mark} ${escape(leaf.description)}`);
            }
            blocks.push('');
        }

        await ctx.bot.sendMessage(msg.chat.id, blocks.join('\n'), {
            parse_mode: 'MarkdownV2',
        });
    } catch (err) {
        logger.error('handleWatchlistCommand failed', { error: err });
        await ctx.bot.sendMessage(
            msg.chat.id,
            'Failed to load watchlist. Check logs.'
        );
    }
}

/**
 * /watch — short usage help for the paste workflow.
 */
export async function handleWatchHelp(
    ctx: TelegramContext,
    msg: TelegramBot.Message
): Promise<void> {
    if (!ctx.isAuthorized(msg.chat.id)) return;

    const help = [
        '*Watch Alerts*',
        '',
        'Paste a JSON rule\\-set \\(from an LLM\\) as a message to create a watch alert\\.',
        'The bot validates it, shows a preview, and asks you to confirm\\.',
        '',
        'Commands:',
        '• `/watchlist` — active alerts \\+ condition progress',
        '• `/watch` — this help',
        '',
        'JSON must include: symbol, thesis, confidence, entry, invalidate, tradePlan\\.',
    ].join('\n');

    await ctx.bot.sendMessage(msg.chat.id, help, { parse_mode: 'MarkdownV2' });
}

/**
 * Detect + validate a pasted JSON watch-alert body.
 * Stages for confirm rather than writing immediately.
 */
export async function handleWatchAlertPaste(
    ctx: TelegramContext,
    msg: TelegramBot.Message
): Promise<boolean> {
    if (!ctx.isAuthorized(msg.chat.id)) return false;
    if (!msg.text) return false;

    const text = msg.text.trim();
    // Heuristic: must look like our watch-alert JSON
    if (!text.startsWith('{') || !text.includes('"entry"') || !text.includes('"tradePlan"')) {
        return false;
    }

    const service = ctx.watchAlertService;
    if (!service) {
        await ctx.sendMessage('Watch alerts are not available right now.');
        return true;
    }

    try {
        const result = await service.stageFromJson(msg.chat.id, text);
        if (!result.ok) {
            const lines = [
                '*Watch alert rejected*',
                '',
                ...result.errors.map(
                    (e) =>
                        `• ${e.field ? `\`${escape(e.field)}\`: ` : ''}${escape(e.message)}`
                ),
            ];
            await ctx.bot.sendMessage(msg.chat.id, lines.join('\n'), {
                parse_mode: 'MarkdownV2',
            });
            return true;
        }

        if (!('pending' in result)) {
            return true;
        }

        await sendPendingPreview(ctx, msg.chat.id, result.pending);
        return true;
    } catch (err) {
        logger.error('handleWatchAlertPaste failed', { error: err });
        await ctx.bot.sendMessage(
            msg.chat.id,
            'Failed to process watch alert JSON.'
        );
        return true;
    }
}

/**
 * Confirm callback — persist staged alert.
 */
export async function handleWatchAlertConfirm(
    ctx: TelegramContext,
    query: TelegramBot.CallbackQuery
): Promise<void> {
    const chatId = query.message?.chat.id;
    if (chatId === undefined || !ctx.isAuthorized(chatId)) return;

    const service = ctx.watchAlertService;
    if (!service) {
        await ctx.bot.answerCallbackQuery(query.id, {
            text: 'Service unavailable',
        });
        return;
    }

    try {
        const result = await service.confirmPending(chatId);
        if (!result.ok) {
            await ctx.bot.answerCallbackQuery(query.id, {
                text: result.errors[0]?.message ?? 'Failed',
                show_alert: true,
            });
            return;
        }

        await ctx.bot.answerCallbackQuery(query.id, { text: 'Alert saved' });
        const a = result.alert;
        const expiresInH = clampExpiryHours(
            (a.expiresAt - a.createdAt) / (60 * 60 * 1000)
        );
        const body = [
            `*Watch alert \\#${escape(a.id)} active*`,
            `\`${escape(a.symbol)}\` — ${escape(a.confidence)}`,
            escape(a.thesis),
            `Direction: ${escape(a.tradePlan.direction)}`,
            `Expires in ${escape(expiresInH)}h`,
        ].join('\n');

        if (query.message) {
            await ctx.bot.editMessageText(body, {
                chat_id: chatId,
                message_id: query.message.message_id,
                parse_mode: 'MarkdownV2',
            });
        } else {
            await ctx.bot.sendMessage(chatId, body, {
                parse_mode: 'MarkdownV2',
            });
        }
    } catch (err) {
        logger.error('handleWatchAlertConfirm failed', { error: err });
        await ctx.bot.answerCallbackQuery(query.id, {
            text: 'Error saving alert',
            show_alert: true,
        });
    }
}

/**
 * Cancel callback — drop staged alert.
 */
export async function handleWatchAlertCancel(
    ctx: TelegramContext,
    query: TelegramBot.CallbackQuery
): Promise<void> {
    const chatId = query.message?.chat.id;
    if (chatId === undefined || !ctx.isAuthorized(chatId)) return;

    const service = ctx.watchAlertService;
    service?.cancelPending(chatId);

    await ctx.bot.answerCallbackQuery(query.id, { text: 'Cancelled' });
    if (query.message) {
        await ctx.bot.editMessageText('Watch alert cancelled\\.', {
            chat_id: chatId,
            message_id: query.message.message_id,
            parse_mode: 'MarkdownV2',
        });
    }
}

/**
 * Route watch_* callback data from the shared callback handler path.
 * Returns true if the callback was consumed.
 */
export async function handleWatchAlertCallback(
    ctx: TelegramContext,
    query: TelegramBot.CallbackQuery
): Promise<boolean> {
    const data = query.data ?? '';
    if (data === 'watch_confirm') {
        await handleWatchAlertConfirm(ctx, query);
        return true;
    }
    if (data === 'watch_cancel') {
        await handleWatchAlertCancel(ctx, query);
        return true;
    }
    return false;
}

// ---------------------------------------------------------------------------

async function sendPendingPreview(
    ctx: TelegramContext,
    chatId: number,
    pending: PendingWatchAlert
): Promise<void> {
    const p = pending.payload;
    const hours = clampExpiryHours(p.expiryHours);
    const inv = p.invalidate ? 'yes' : 'none';

    const lines = [
        `*Watch alert preview*`,
        ``,
        `*Symbol:* \`${escape(p.symbol)}\``,
        `*Confidence:* ${escape(p.confidence)}`,
        `*Direction:* ${escape(p.tradePlan.direction)}`,
        `*Expiry:* ${escape(hours)}h`,
        `*Invalidate tree:* ${escape(inv)}`,
        ``,
        `*Thesis:*`,
        escape(p.thesis),
        ``,
        `*Trade plan:*`,
        `SL: ${escape(p.tradePlan.stopLoss.type)} ${escape(p.tradePlan.stopLoss.value)}`,
        `TP: ${escape(p.tradePlan.takeProfit.type)} ${escape(p.tradePlan.takeProfit.value)}`,
        p.tradePlan.trailing
            ? `Trail: act ${escape(p.tradePlan.trailing.activationPct)}% / giveback ${escape(p.tradePlan.trailing.givebackPct)}%`
            : `Trail: none`,
        ``,
        `Confirm to start watching\\.`,
    ];

    await ctx.bot.sendMessage(chatId, lines.join('\n'), {
        parse_mode: 'MarkdownV2',
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '✅ Confirm', callback_data: 'watch_confirm' },
                    { text: '❌ Cancel', callback_data: 'watch_cancel' },
                ],
            ],
        },
    });
}

// silence unused import warning if formatR not used in this file
void formatR;
