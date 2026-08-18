// src/lib/services/telegram/signalAlert.ts
// sendSignalAlert — called externally via TelegramBotController.sendSignalAlert
// CRITICAL: MarkdownV2 escaping copied VERBATIM

import type { TradeSignal } from '../../../types';
import { createLogger } from '../../logger';
import { excursionCache } from '../excursionHistoryCache';
import type { TelegramContext } from './context';

const logger = createLogger('TelegramBot');

export async function sendSignalAlert(ctx: TelegramContext,
    symbol: string,
    signal: TradeSignal,
    price: number,
    regimeScore?: number,          // NEW: pass from AutoTradeService after getExcursionAdvice()
    tradeExecuted: boolean = true
): Promise<void> {

    // ─────────────────────────────────────────────────────────────────────────
    // HELPERS
    // ─────────────────────────────────────────────────────────────────────────

    /** Escape all MarkdownV2 special characters */
    const esc = (value: string | number | undefined): string => {
        if (value === undefined || value === null) return '';
        return String(value).replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1');
    };

    /** Format a percentage for display — always 2dp, sign-aware */
    const pct = (value: number, showPlus = false): string => {
        const sign = showPlus && value > 0 ? '+' : '';
        return `${sign}${value.toFixed(2)}%`;
    };

    /** Outcome → compact emoji + label */
    const outcomeEmoji = (outcome: string): string => {
        switch (outcome) {
            case 'tp': return '✅ tp';
            case 'partial_tp': return '✅ partial\\_tp';
            case 'sl': return '❌ sl';
            case 'timeout': return '⏱ timeout';
            default: return '— unknown';
        }
    };

    // ─────────────────────────────────────────────────────────────────────────
    // CONSTANTS
    // ─────────────────────────────────────────────────────────────────────────

    /** Sides with fewer than this many samples get a "thin data" warning */
    const MIN_RELIABLE_SAMPLES = 3;

    /** MFE/MAE display threshold — show even small values at scalping scale */
    const MIN_DISPLAY_PCT = 0.15;

    const lines: string[] = [];

    // ─────────────────────────────────────────────────────────────────────────
    // 1. COMPACT HEADER — direction · symbol · price on one line
    // ─────────────────────────────────────────────────────────────────────────
    const dirEmoji = signal.signal === 'buy' ? '🟢' : '🔴';
    const dirLabel = signal.signal === 'buy' ? 'LONG' : 'SHORT';
    const wasReversed = signal.reason?.some(r =>
        r.includes('REVERSED') || r.includes('reverse')
    ) ?? false;
    const reversedTag = wasReversed ? ' ↔️ _REVERSED_' : '';

    if (!tradeExecuted) {
        lines.push('🔔 _SIGNAL ONLY \\(auto\\-trade off\\)_');
    }

    lines.push(
        `${dirEmoji} *${dirLabel}${reversedTag}* · ${esc(symbol)} · \\$${esc(price.toFixed(6))}`
    );

    // ─────────────────────────────────────────────────────────────────────────
    // 2. KEY LEVELS — SL / TP / R:R on one line
    // ─────────────────────────────────────────────────────────────────────────
    const slStr = signal.stopLoss
        ? `SL **\\$${esc(signal.stopLoss.toFixed(6))}**`
        : 'SL —';

    const tpStr = signal.takeProfit
        ? `TP **\\$${esc(signal.takeProfit.toFixed(6))}**`
        : 'TP —';

    const rrStr = signal.takeProfit && signal.stopLoss && price !== signal.stopLoss
        ? ` · ${esc(
            Math.abs((signal.takeProfit - price) / (price - signal.stopLoss)).toFixed(1)
        )}R`
        : '';

    lines.push(`${slStr} · ${tpStr}${rrStr}`);

    // ─────────────────────────────────────────────────────────────────
    // TRAILING STOP PREVIEW (live/manual execution only)
    // Shown whenever AutoTradeService attached these — either the
    // pre-fill preview (auto-trade off / alert-only) or the real
    // post-fill values (auto-trade on). Gives you the numbers to
    // punch into Bybit manually while auto-trade stays disabled.
    // ─────────────────────────────────────────────────────────────────
    if (signal.trailingActivePrice !== undefined && signal.trailingGivebackPrice !== undefined) {
        const givebackPct = ((signal.trailingGivebackPrice / price) * 100).toFixed(3);
        const activationPct = signal.signal === 'buy'
            ? (((signal.trailingActivePrice - price) / price) * 100).toFixed(2)
            : (((price - signal.trailingActivePrice) / price) * 100).toFixed(2);

        lines.push(
            `🎯 Trail arms \\$${esc(signal.trailingActivePrice.toFixed(6))} ` +
            `\\(\\+${esc(activationPct)}%\\) · giveback \\$${esc(signal.trailingGivebackPrice.toFixed(6))} ` +
            `\\(${esc(givebackPct)}%\\)`
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 3. CONFIDENCE — only if meaningful (skip internal boilerplate reasons)
    // ─────────────────────────────────────────────────────────────────────────
    const confParts: string[] = [];
    if (signal.confidence > 0) {
        confParts.push(`${esc(signal.confidence.toFixed(1))}%`);
    }
    if (confParts.length > 0) {
        lines.push(`⚡ Confidence: ${confParts.join(' · ')}`);
    }

    // ML prediction block — only show when model made a prediction
    if (signal.mlConfidence !== undefined && signal.mlPredictedLabel !== undefined) {
        const labelStr = signal.mlPredictedLabel >= 0
            ? `+${signal.mlPredictedLabel}`
            : `${signal.mlPredictedLabel}`;
        const positivePct = esc((signal.mlConfidence * 100).toFixed(1));
        const negativePctRaw = ((1 - signal.mlConfidence) * 100).toFixed(1);
        const negativeWarning = (1 - signal.mlConfidence) >= 0.35
            ? ` ⚠️ negative risk: ${negativePctRaw}%`
            : '';
        lines.push(`🤖 ML: predicted *${esc(labelStr)}* · positive: ${positivePct}%${esc(negativeWarning)}`);
    } else if (signal.mlConfidence !== undefined) {
        // Model ran but label not stored (shouldn't happen after this change)
        lines.push(`🤖 ML: ${esc((signal.mlConfidence * 100).toFixed(1))}% positive`);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 4. TECHNICAL REASONS — compact, strip boilerplate
    // ─────────────────────────────────────────────────────────────────────────
    const BOILERPLATE_PATTERNS = [
        /Fixed.*leverage/i,
        /Confidence boost/i,
        /R:R/i,
        /excursion/i,        // regime summary already shown below
    ];

    // ─────────────────────────────────────────────────────────────────────────
    // 5. REGIME DATA
    // ─────────────────────────────────────────────────────────────────────────
    const regime = excursionCache.getRegime(symbol);

    lines.push('');

    if (!regime || regime.recentSampleCount === 0) {
        lines.push('📊 _No regime data yet_');
    } else {
        const totalSims = regime.recentSampleCount;
        const buySims = regime.buy?.sampleCount ?? 0;
        const sellSims = regime.sell?.sampleCount ?? 0;

        lines.push(`📊 *Regime* — ${totalSims} sims \\(${buySims} buy / ${sellSims} sell\\)`);

        // ── 5a. LAST 2 SAME-DIRECTION SIMS ─────────────────────────────────
        // Pull from historyJson, filter to signal direction, take most recent 2
        const signalDir = signal.signal === 'buy' ? 'buy' : 'sell';

        const recentSameSide: Array<{
            outcome: string;
            mfe: number;
            mae: number;
            label: number;
            timestamp: number;
            mlPredictedLabel?: number;
        }> = [];

        if ('historyJson' in regime && Array.isArray(regime.historyJson)) {
            const filtered = regime.historyJson
                .filter(e => e.direction === signalDir)
                .slice(0, 2);   // historyJson is already newest-first

            for (const e of filtered) {
                recentSameSide.push({
                    outcome: e.outcome,
                    mfe: e.mfe ?? 0,     // already in % (boundedMfe from simulator)
                    mae: e.mae ?? 0,     // already in % (boundedMae, negative)
                    label: e.label,
                    timestamp: e.timestamp,
                    mlPredictedLabel: e.mlPredictedLabel,
                });
            }
        }

        if (recentSameSide.length > 0) {
            lines.push('');
            lines.push(`*Last ${recentSameSide.length} ${signalDir} sim${recentSameSide.length > 1 ? 's' : ''}:*`);

            recentSameSide.forEach((sim, idx) => {
                const mfeStr = Math.abs(sim.mfe) >= MIN_DISPLAY_PCT
                    ? ` MFE ${esc(pct(sim.mfe, true))}`
                    : '';
                const maeStr = Math.abs(sim.mae) >= MIN_DISPLAY_PCT
                    ? ` MAE ${esc(pct(sim.mae))}`
                    : '';

                const simAgeMs = Date.now() - sim.timestamp;
                const simAgeMin = Math.floor(simAgeMs / 60000);
                const simAgeStr = simAgeMin < 60
                    ? `${simAgeMin}m ago`
                    : `${Math.floor(simAgeMin / 60)}h ${simAgeMin % 60}m ago`;

                const mlPredStr = sim.mlPredictedLabel !== undefined
                    ? ` · ML predicted ${sim.mlPredictedLabel >= 0 ? '\\+' : ''}${esc(sim.mlPredictedLabel)}`
                    : '';

                lines.push(
                    `  ${idx === 0 ? '→' : '  '} ${outcomeEmoji(sim.outcome)} · ${esc(simAgeStr)}${mfeStr}${maeStr} \\(outcome ${sim.label >= 0 ? '\\+' : ''}${esc(sim.label)}${mlPredStr}\\)`
                );
            });
        }

        // ── 5b. SL STREAK WARNING ───────────────────────────────────────────
        const slStreak = signal.signal === 'buy'
            ? (regime.slStreakBuy ?? 0)
            : (regime.slStreakSell ?? 0);

        if (slStreak >= 2) {
            const streakIcon = slStreak >= 3 ? '🔥' : '⚠️';
            // Data shows: after 2 SLs → 47.4% chance of another (vs 36.3% baseline)
            //             after 3 SLs → 50.9% chance
            const riskNote = slStreak >= 3
                ? `~51% chance next is also SL`
                : `~47% chance next is also SL`;
            lines.push(`${streakIcon} *${slStreak} consecutive SL* on ${signalDir} side — ${esc(riskNote)}`);
        }

        // ── 5c. BUY SIDE ────────────────────────────────────────────────────
        lines.push('');

        if (regime.buy && regime.buy.sampleCount > 0) {
            const buy = regime.buy;
            const maeAbs = Math.abs(buy.mae);
            const ratioIcon = buy.excursionRatio > 2.0 ? '🟢'
                : buy.excursionRatio < 1.0 ? '🔴' : '🟡';
            const scoreStr = regimeScore !== undefined && signal.signal === 'buy'
                ? ` — score *${esc(regimeScore.toFixed(1))}*`
                : '';
            const thinTag = buy.sampleCount < MIN_RELIABLE_SAMPLES
                ? ' ⚠️ _thin_' : '';

            lines.push(`🧭 *Buy regime* \\(${buy.sampleCount} sims\\)${scoreStr}${thinTag}`);

            // MFE / MAE / ratio (scaled for scalping — show from 0.15%)
            const mfeDisplay = buy.mfe >= MIN_DISPLAY_PCT
                ? `\\+${esc(buy.mfe.toFixed(2))}%`
                : `\\+${esc(buy.mfe.toFixed(3))}%`;
            const maeDisplay = maeAbs >= MIN_DISPLAY_PCT
                ? `\\-${esc(maeAbs.toFixed(2))}%`
                : `\\-${esc(maeAbs.toFixed(3))}%`;

            lines.push(
                `  MFE ${mfeDisplay} · MAE ${maeDisplay} · ratio ${esc(buy.excursionRatio.toFixed(2))} ${ratioIcon}`
            );

            // Outcomes
            const oc = buy.outcomeCounts;
            const ocTotal = oc.tp + oc.partial_tp + oc.sl + oc.timeout;
            if (ocTotal > 0) {
                const winPct = ((oc.tp + oc.partial_tp) / ocTotal * 100).toFixed(0);
                const slPct = (oc.sl / ocTotal * 100).toFixed(0);
                lines.push(esc(`  ${winPct}% wins · ${slPct}% SL · ${oc.timeout} timeouts`));
            }

            // Duration
            const durMin = (buy.avgDurationMs / 60000).toFixed(1);
            lines.push(`  Avg ${esc(durMin)} min`);

            // MFE-first % — computed from historyJson buy entries
            if ('historyJson' in regime && Array.isArray(regime.historyJson)) {
                const buySims = regime.historyJson.filter(e =>
                    e.direction === 'buy' &&
                    (e.timeToMFE_ms ?? 0) > 0 &&
                    (e.timeToMAE_ms ?? 0) > 0
                );
                if (buySims.length >= 3) {
                    const mfeFirst = buySims.filter(e =>
                        (e.timeToMFE_ms ?? Infinity) < (e.timeToMAE_ms ?? Infinity)
                    ).length;
                    const mfeFirstPct = (mfeFirst / buySims.length * 100).toFixed(0);
                    // ≥60% MFE-first = cleaner entries worth noting
                    if (Number(mfeFirstPct) >= 60 || Number(mfeFirstPct) <= 30) {
                        const note = Number(mfeFirstPct) >= 60
                            ? '⚡ runs before dipping'
                            : '⚠️ dips before running';
                        lines.push(`  MFE arrives first ${esc(mfeFirstPct)}% — ${note}`);
                    }
                }
            }

            if (maeAbs >= 1.0) {
                lines.push(`  ⚠️ High drawdown on buy side`);
            }
            if (regime.slStreakBuy && regime.slStreakBuy >= 3) {
                lines.push(`  🔥 ${regime.slStreakBuy} consecutive SL streak`);
            }
        } else {
            lines.push('🧭 *Buy regime:* _No data yet_');
        }

        // ── 5d. SELL SIDE ───────────────────────────────────────────────────
        lines.push('');

        if (regime.sell && regime.sell.sampleCount > 0) {
            const sell = regime.sell;
            const maeAbs = Math.abs(sell.mae);
            const ratioIcon = sell.excursionRatio > 2.0 ? '🟢'
                : sell.excursionRatio < 1.0 ? '🔴' : '🟡';
            const scoreStr = regimeScore !== undefined && signal.signal === 'sell'
                ? ` — score *${esc(regimeScore.toFixed(1))}*`
                : '';
            const thinTag = sell.sampleCount < MIN_RELIABLE_SAMPLES
                ? ' ⚠️ _thin_' : '';

            lines.push(`🧭 *Sell regime* \\(${sell.sampleCount} sims\\)${scoreStr}${thinTag}`);

            const mfeDisplay = sell.mfe >= MIN_DISPLAY_PCT
                ? `\\+${esc(sell.mfe.toFixed(2))}%`
                : `\\+${esc(sell.mfe.toFixed(3))}%`;
            const maeDisplay = maeAbs >= MIN_DISPLAY_PCT
                ? `\\-${esc(maeAbs.toFixed(2))}%`
                : `\\-${esc(maeAbs.toFixed(3))}%`;

            lines.push(
                `  MFE ${mfeDisplay} · MAE ${maeDisplay} · ratio ${esc(sell.excursionRatio.toFixed(2))} ${ratioIcon}`
            );

            const oc = sell.outcomeCounts;
            const ocTotal = oc.tp + oc.partial_tp + oc.sl + oc.timeout;
            if (ocTotal > 0) {
                const winPct = ((oc.tp + oc.partial_tp) / ocTotal * 100).toFixed(0);
                const slPct = (oc.sl / ocTotal * 100).toFixed(0);
                lines.push(esc(`  ${winPct}% wins · ${slPct}% SL · ${oc.timeout} timeouts`));
            }

            const durMin = (sell.avgDurationMs / 60000).toFixed(1);
            lines.push(`  Avg ${esc(durMin)} min`);

            // MFE-first % for sell side
            if ('historyJson' in regime && Array.isArray(regime.historyJson)) {
                const sellSims = regime.historyJson.filter(e =>
                    e.direction === 'sell' &&
                    (e.timeToMFE_ms ?? 0) > 0 &&
                    (e.timeToMAE_ms ?? 0) > 0
                );
                if (sellSims.length >= 3) {
                    const mfeFirst = sellSims.filter(e =>
                        (e.timeToMFE_ms ?? Infinity) < (e.timeToMAE_ms ?? Infinity)
                    ).length;
                    const mfeFirstPct = (mfeFirst / sellSims.length * 100).toFixed(0);
                    if (Number(mfeFirstPct) >= 60 || Number(mfeFirstPct) <= 30) {
                        const note = Number(mfeFirstPct) >= 60
                            ? '⚡ runs before dipping'
                            : '⚠️ dips before running';
                        lines.push(`  MFE arrives first ${esc(mfeFirstPct)}% — ${note}`);
                    }
                }
            }

            if (maeAbs >= 1.0) {
                lines.push(`  ⚠️ High drawdown on sell side`);
            }
            if (regime.slStreakSell && regime.slStreakSell >= 3) {
                lines.push(`  🔥 ${regime.slStreakSell} consecutive SL streak`);
            }
        } else {
            lines.push('🧭 *Sell regime:* _No data yet_');
        }
    }


    const meaningfulReasons = (signal.reason ?? [])
        .filter(r => !BOILERPLATE_PATTERNS.some(p => p.test(r)))
        .filter(Boolean);

    if (meaningfulReasons.length > 0) {
        lines.push(`→ ${meaningfulReasons.map(esc).join(' · ')}`);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 6. TIMESTAMP — compact, no date (you know what day it is)
    // ─────────────────────────────────────────────────────────────────────────
    const timeStr = new Date().toISOString().slice(11, 19); // HH:MM:SS only
    lines.push('');
    lines.push(`🕒 ${esc(timeStr)}`);

    // ─────────────────────────────────────────────────────────────────────────
    // 7. SEND
    // ─────────────────────────────────────────────────────────────────────────
    const message = lines.join('\n');

    try {
        await ctx.sendMessage(message, { parse_mode: 'MarkdownV2' });
        logger.info(`Signal alert sent for ${symbol} (${signal.signal}${wasReversed ? ' REVERSED' : ''})`, {
            tradeExecuted,
            regimeScore,
        });
    } catch (err) {
        logger.error('Failed to send signal alert', {
            symbol,
            signal: signal.signal,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

/**
 * Stops the bot from polling and clears the cleanup interval.
 */
