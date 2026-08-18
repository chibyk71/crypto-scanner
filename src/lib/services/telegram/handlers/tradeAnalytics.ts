// src/lib/services/telegram/handlers/tradeAnalytics.ts
// handleTakenStats, handleTakenSymbols, handleTakenVsAll, handleExcursions
// CRITICAL: MarkdownV2 escaping copied VERBATIM — do not add/remove escape calls

import type TelegramBot from 'node-telegram-bot-api';
import { dbService } from '../../../db';
import { createLogger } from '../../../logger';
import { excursionCache } from '../../excursionHistoryCache';
import type { TelegramContext } from '../context';
import { escape, formatPercent, formatR } from '../utils/markdown';

const logger = createLogger('TelegramBot');

export async function handleTakenStats(ctx: TelegramContext, msg: TelegramBot.Message, match: RegExpExecArray | null): Promise<void> {
    // Early authorization check
    if (msg.chat.id.toString() !== this.authorizedChatId) {
        return;
    }

    // Extract optional symbol filter from command argument
    const symbolFilter = match?.[1]?.trim();

    try {
        // Fetch stats (with optional symbol filter)
        const stats = await dbService.getTakenSimulationStats({
            symbol: symbolFilter || undefined,
        });

        // Build message content
        const lines: string[] = [];

        // Header
        if (symbolFilter) {
            lines.push(`**Taken Trade Stats for ${escape(symbolFilter)}**`);
        } else {
            lines.push('**Taken Trade Statistics \\(All Symbols\\)**');
        }

        lines.push(`Total taken trades: **${escape(stats.totalTaken)}**`);

        if (stats.totalTaken === 0) {
            lines.push('');
            lines.push(escape('No taken trades have been recorded yet.'));
        } else {
            // Performance summary
            lines.push(`Wins: **${stats.wins}** \\(${formatPercent(stats.winRate, 1)}\\)`);
            lines.push(`Win rate: **${formatPercent(stats.winRate, 1)}**`);
            lines.push(`Average R\\-multiple: **${formatR(stats.avgRMultiple)}**`);
            lines.push(`Average PnL: **${escape((stats.avgPnL.toFixed(4)))}**`);
            lines.push(`Total realized PnL: **${escape(stats.totalPnL.toFixed(4))}**`);

            // Outcome distribution
            lines.push('');
            lines.push('**Outcome Breakdown**');
            lines.push(`• Take Profit: ${escape(stats.outcomes.tp)}`);
            lines.push(`• Partial TP:   ${escape(stats.outcomes.partial_tp)}`);
            lines.push(`• Stop Loss:    ${escape(stats.outcomes.sl)}`);
            lines.push(`• Timeout:      ${escape(stats.outcomes.timeout)}`);
        }

        // Timestamp / freshness note
        lines.push('');
        lines.push(`🕒 Updated: ${escape(new Date().toLocaleString('en-US', { timeZone: 'Africa/Lagos' }))} WAT`);

        // Send formatted message
        await ctx.sendMessage(lines.join('\n'), {
            parse_mode: 'MarkdownV2',
        });

        logger.info('Sent taken stats response', {
            chatId: msg.chat.id,
            symbol: symbolFilter || 'all',
            totalTaken: stats.totalTaken,
        });
    } catch (error) {
        // Log detailed error for debugging
        logger.error('Failed to handle /takenstats command', {
            chatId: msg.chat.id,
            symbolFilter,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
        });

        // User-friendly error message
        await ctx.sendMessage(
            'Sorry, there was an error fetching the taken trade statistics.\n' +
            'Please check the logs or try again later.',
            { parse_mode: 'Markdown' }
        );
    }
};

/**
 * Handles /ml_reload command.
 * Reloads the ONNX model from disk without restarting the bot.
 * Use after uploading a new model.onnx to the server.
 */
export async function handleTakenSymbols(ctx: TelegramContext, 
    msg: TelegramBot.Message,
    match: RegExpExecArray | null
): Promise<void> {
    // Security: only respond to authorized user
    if (msg.chat.id.toString() !== this.authorizedChatId) {
        return;
    }

    // Parse and clamp the optional limit argument (3–30, default 10)
    let limit = 10;
    if (match?.[1]) {
        const parsed = parseInt(match[1], 10);
        if (!isNaN(parsed)) {
            limit = Math.min(Math.max(3, parsed), 30);
        }
    }

    try {
        // Fetch top symbols from database
        const topSymbols = await dbService.getTakenStatsBySymbol(limit);

        // Prepare message content
        const lines: string[] = [
            `**Top ${limit} Symbols by Taken Trades**`,
            '',
        ];

        if (topSymbols.length === 0) {
            lines.push('No taken trades have been recorded yet\\.');
            lines.push(escape('Once some filtered trades occur, top performers will appear here.'));
        } else {
            // Build ranked list
            topSymbols.forEach((s, index) => {
                const rank = index + 1;
                const winRateStr = formatPercent(s.winRate, 1);
                const avgRStr = formatR(s.avgR);

                lines.push(
                    `${rank}\\. **${escape(s.symbol)}**` +
                    ` — ${escape(s.totalTaken)} trades` +
                    ` — Win rate: **${winRateStr}**` +
                    ` — Avg R: **${avgRStr}**`
                );
            });

            // Optional footer note
            lines.push('');
            lines.push('Sorted by number of taken trades \\(descending\\)\\.');
        }

        // Add data freshness indicator
        lines.push('');
        lines.push(
            `🕒 Updated: ${escape(new Date().toLocaleString('en-US', { timeZone: 'Africa/Lagos' }))} WAT`
        );

        // Send formatted response
        await ctx.sendMessage(lines.join('\n'), {
            parse_mode: 'MarkdownV2',
        });

        // Log success for usage tracking / debugging
        logger.info('Sent top taken symbols response', {
            chatId: msg.chat.id,
            requestedLimit: limit,
            returnedCount: topSymbols.length,
        });
    } catch (error) {
        // Detailed error logging
        logger.error('Failed to handle /takensymbols command', {
            chatId: msg.chat.id,
            requestedLimit: limit,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack?.slice(0, 300) : undefined,
        });

        // User-friendly error message
        await ctx.sendMessage(
            'Sorry, could not fetch the top symbols statistics right now.\n' +
            'Please check the logs or try again later.',
            { parse_mode: 'Markdown' }
        );
    }
};

/**
 * Handles the /takenvsall command.
 * Shows a quick comparison between:
 *   - Total number of closed simulations
 *   - Number of simulations marked as taken (filtered/executed)
 *   - Percentage of simulations that passed the excursion/regime filter
 *
 * Purpose: Helps evaluate how selective the filtering logic is.
 */
export async function handleTakenVsAll(ctx: TelegramContext, msg: TelegramBot.Message): Promise<void> {
    // Early exit if not authorized user
    if (msg.chat.id.toString() !== this.authorizedChatId) {
        return;
    }

    try {
        // Fetch comparison counts from DB
        const counts = await dbService.getTakenVsTotalCount();

        // Build message content
        const lines: string[] = [
            '**Taken vs All Simulations**',
            '',
            `Total closed simulations: **${escape((counts.totalSims.toLocaleString()))}**`,
            `Taken \\(filtered/executed\\): **${escape(counts.takenSims.toLocaleString())}**`,
        ];

        // Only show percentage if we have valid data
        if (counts.totalSims > 0) {
            lines.push(
                `Percentage taken: **${formatPercent(counts.takenPercentage, 1)}**`
            );
        } else {
            lines.push('Percentage taken: **N/A** \\(no simulations yet\\)');
        }

        lines.push('');

        // Interpretation / context
        if (counts.takenSims === 0) {
            lines.push('⚠️ No trades have passed the excursion filter yet\\.');
            lines.push('This could mean: limited data, strict regime rules, or no strong signals\\.');
        } else if (counts.takenPercentage < 20) {
            lines.push(escape('The filter is currently **very selective** (<20%).'));
            lines.push('This is good for quality — but may limit trade frequency\\.');
        } else if (counts.takenPercentage > 60) {
            lines.push(escape('The filter is **quite permissive** (>60%).'));
            lines.push('Consider tightening regime rules if too many weak trades are passing\\.');
        } else {
            lines.push('The filter is moderately selective — balanced approach\\.');
        }

        // Add freshness timestamp (helps user know data is current)
        lines.push('');
        lines.push(
            `🕒 Stats as of ${escape(new Date().toLocaleString('en-US', { timeZone: 'Africa/Lagos' }))} WAT`
        );

        // Send the formatted message
        await ctx.sendMessage(lines.join('\n'), {
            parse_mode: 'MarkdownV2',
        });

        // Log successful response (useful for monitoring usage)
        logger.info('Sent taken vs all stats response', {
            chatId: msg.chat.id,
            totalSims: counts.totalSims,
            takenSims: counts.takenSims,
            takenPct: counts.takenPercentage.toFixed(1),
        });
    } catch (error) {
        // Detailed logging for debugging
        logger.error('Failed to handle /takenvsall command', {
            chatId: msg.chat.id,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack?.slice(0, 300) : undefined,
        });

        // User-friendly fallback message
        await ctx.sendMessage(
            'Sorry, could not fetch the taken vs all comparison right now.\n' +
            'Please check the logs or try again later.',
            { parse_mode: 'Markdown' }
        );
    }
};

/**
 * Handles the /ml_pause command.
 *
 * Pauses ongoing ML model training.
 * Provides confirmation and logs action.
 *
 * @param msg - Incoming Telegram message
 * @private
 */
export async function handleExcursions(ctx: TelegramContext, msg: TelegramBot.Message, match: RegExpExecArray | null): Promise<void> {
    if (!ctx.isAuthorized(msg.chat.id)) return;

    const chatId = msg.chat.id;
    const symbolInput = match?.[1]?.trim().toUpperCase();

    // Robust MarkdownV2 escape
    const escape = (value: string | number | undefined): string => {
        if (value === undefined || value === null) return '';
        const str = String(value);
        return str.replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1');
    };


    if (!symbolInput) {
        await ctx.bot.sendMessage(
            chatId,
            `*Usage:* \`/excursions BTC/USDT\`\n\nShows pure directional excursion stats and individual simulation details for a symbol\\.`,
            { parse_mode: 'Markdown' }
        );
        return;
    }

    try {
        // Fetch current regime (cache with pure directional aggregates)
        const regime = excursionCache.getRegime(symbolInput);

        if (!regime || regime.recentSampleCount === 0) {
            await ctx.bot.sendMessage(
                chatId,
                `ℹ️ *No excursion data yet for ${escape(symbolInput)}*\n\nWaiting for first simulation to complete\\.`,
                { parse_mode: 'Markdown' }
            );
            return;
        } ``

        const lines: string[] = [`**Excursion Analysis: ${symbolInput}** 📊`];

        // ── Total count (only combined field shown – for context) ──────────────────────
        const totalSims = regime.recentSampleCount;
        const buySims = regime.buy?.sampleCount ?? 0;
        const sellSims = regime.sell?.sampleCount ?? 0;

        lines.push(`Total recent sims: **${escape(totalSims)}** \\(Buys: ${escape(buySims)}, Sells: ${escape(sellSims)}\\)`);

        // ── BUY SIDE REGIME ─────────────────────────────────────────────────────────────
        if (regime.buy && regime.buy.sampleCount > 0) {
            const buy = regime.buy;
            const durMin = (buy.avgDurationMs / 60000).toFixed(1);
            const maeAbs = Math.abs(buy.mae);
            const ratioColor = buy.excursionRatio > 2.0 ? '🟢' : buy.excursionRatio < 1.0 ? '🔴' : '🟡';

            lines.push('');
            lines.push(`**Buy / Long Regime** \\(${escape(buy.sampleCount)} sims\\)`);
            lines.push(`MFE: **\\+${escape(buy.mfe.toFixed(2))}%**`);
            lines.push(`MAE: **\\-${escape(maeAbs.toFixed(2))}%**`);
            lines.push(`Ratio: **${escape(buy.excursionRatio.toFixed(2))}** ${ratioColor}`);
            lines.push(`Avg duration: **${escape(durMin)} min**`);

            const oc = buy.outcomeCounts;
            const total = oc.tp + oc.partial_tp + oc.sl + oc.timeout;
            if (total > 0) {
                const tpPct = ((oc.tp + oc.partial_tp) / total * 100).toFixed(0);
                const slPct = (oc.sl / total * 100).toFixed(0);
                lines.push(`Outcomes: **${escape(tpPct)}% wins** / **${escape(slPct)}% SL** / ${escape(oc.timeout)} timeouts`);
            }

            if (maeAbs >= 2.5) {
                lines.push('⚠️ High drawdown risk on buy side');
            }
        } else {
            lines.push('');
            lines.push('**Buy / Long Regime:** No data yet');
        }

        // ── SELL SIDE REGIME ────────────────────────────────────────────────────────────
        if (regime.sell && regime.sell.sampleCount > 0) {
            const sell = regime.sell;
            const durMin = (sell.avgDurationMs / 60000).toFixed(1);
            const maeAbs = Math.abs(sell.mae);
            const ratioColor = sell.excursionRatio > 2.0 ? '🟢' : sell.excursionRatio < 1.0 ? '🔴' : '🟡';

            lines.push('');
            lines.push(`**Sell / Short Regime** \\(${escape(sell.sampleCount)} sims\\)`);
            lines.push(`MFE: **\\+${sell.mfe.toFixed(2)}%**`);
            lines.push(`MAE: **\\-${escape(maeAbs.toFixed(2))}%**`);
            lines.push(`Ratio: **${escape(sell.excursionRatio.toFixed(2))}** ${ratioColor}`);
            lines.push(`Avg duration: **${escape(durMin)} min**`);
            const oc = sell.outcomeCounts;
            const total = oc.tp + oc.partial_tp + oc.sl + oc.timeout;
            if (total > 0) {
                const tpPct = ((oc.tp + oc.partial_tp) / total * 100).toFixed(0);
                const slPct = (oc.sl / total * 100).toFixed(0);
                lines.push(`Outcomes: **${escape(tpPct)}% wins** / **${escape(slPct)}% SL** / ${escape(oc.timeout)} timeouts`);
            }

            if (maeAbs >= 2.5) {
                lines.push('⚠️ High drawdown risk on sell side');
            }
        } else {
            lines.push('');
            lines.push('**Sell / Short Regime:** No data yet');
        }

        // ── INDIVIDUAL SIMULATION DETAILS ──────────────────────────────────────────────
        if (regime.historyJson && regime.historyJson.length > 0) {
            lines.push('');
            lines.push('**Recent Individual Simulations** \\(newest first\\)');

            const now = Date.now();
            regime.historyJson.forEach((entry, index) => {
                const ageMs = now - entry.timestamp;
                const ageMin = Math.floor(ageMs / 60000);
                const ageStr = ageMin < 60 ? `${ageMin} min ago` : `${Math.floor(ageMin / 60)}h ${ageMin % 60} min ago`;

                const durMin = (entry.durationMs / 60000).toFixed(1);
                const mfeStr = `+${entry.mfe.toFixed(2)}%`;
                const maeStr = `-${Math.abs(entry.mae).toFixed(2)}%`;

                const timeToMFE = entry.timeToMFE_ms > 0 ? `${(entry.timeToMFE_ms / 1000).toFixed(0)}s` : 'n/a';
                const timeToMAE = entry.timeToMAE_ms > 0 ? `${(entry.timeToMAE_ms / 1000).toFixed(0)}s` : 'n/a';

                lines.push(`**\\#${index + 1}** ${escape(ageStr)} • ${escape(entry.direction.toUpperCase())} • ${escape(entry.outcome.toUpperCase())}`);
                lines.push(`Duration: ${escape(durMin)} min • MFE: ${escape(mfeStr)} • MAE: ${escape(maeStr)}`);
                lines.push(`Time to MFE: ${escape(timeToMFE)} • Time to MAE: ${escape(timeToMAE)}`);
                lines.push('─');
            });
        } else {
            lines.push('');
            lines.push('No individual simulation details available yet\\.');
        }

        // ── FINAL MESSAGE ───────────────────────────────────────────────────────────────
        await ctx.bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'MarkdownV2' });
    } catch (error: any) {
        logger.error('Error in /excursions command', { symbol: symbolInput, error });
        await ctx.sendMessage('❌ Failed to retrieve excursion statistics. Please try again later.');
    }
};

/**
 * Starts periodic cleanup of stale user states.
 * - Removes states inactive for longer than STATE_TIMEOUT_MS.
 * @private
 */
