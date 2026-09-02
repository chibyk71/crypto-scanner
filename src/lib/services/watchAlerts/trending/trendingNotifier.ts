// src/lib/watchAlerts/trending/trendingNotifier.ts
// isTrending-gate consumer — max once per symbol per TRENDING_NOTIFY_COOLDOWN_MS.

import { dbService } from '../../../db';
import { createLogger } from '../../../logger';
import type { TrendAndVolume } from '../../../strategy/types';
import type { IndicatorMap } from '../../../utils/indicatorUtils';
import { escape, formatPercent } from '../../telegram/utils/markdown';
import type { TelegramBotController } from '../../telegramBotController';
import { TRENDING_NOTIFY_COOLDOWN_MS } from '../constants';

const logger = createLogger('TrendingNotifier');

/**
 * If the symbol is trending and we have not notified within the cooldown window,
 * send a compact Telegram message suitable as LLM prompt context, then record
 * the notification timestamp.
 */
export async function checkAndNotify(
    symbol: string,
    trendAndVolume: TrendAndVolume,
    indicators: IndicatorMap,
    telegram?: TelegramBotController
): Promise<boolean> {
    if (!trendAndVolume.isTrending) {
        return false;
    }

    const last = await dbService.getLastTrendingNotification(symbol);
    const now = Date.now();
    if (last !== null && now - last < TRENDING_NOTIFY_COOLDOWN_MS) {
        return false;
    }

    if (!telegram) {
        // Still record so we don't spam once telegram comes online mid-cycle
        await dbService.recordTrendingNotification(symbol, now);
        return false;
    }

    const lastSnap = indicators.last;
    const price = lastSnap.close;
    const atr = lastSnap.atr;
    const atrPct = price > 0 ? (atr / price) * 100 : 0;

    // Compact snapshot of allowed-indicator values for LLM context
    const lines = [
        `*Trending setup detected*`,
        ``,
        `*Symbol:* \`${escape(symbol)}\``,
        `*Trend bias:* ${escape(trendAndVolume.trendBias)}`,
        `*ADX:* ${escape(lastSnap.htfAdx.toFixed(2))}  \\(\\+DI ${escape(lastSnap.htfPdi.toFixed(2))} / \\-DI ${escape(lastSnap.htfMdi.toFixed(2))}\\)`,
        `*Price:* ${escape(price.toFixed(6))}`,
        `*ATR:* ${escape(atr.toFixed(6))} \\(${formatPercent(atrPct)}\\)`,
        ``,
        `*Indicator snapshot \\(primary TF\\):*`,
        `• RSI: ${escape(lastSnap.rsi.toFixed(2))}`,
        `• EMA20: ${escape(lastSnap.emaShort.toFixed(6))}  EMA50: ${escape(lastSnap.emaMid.toFixed(6))}  EMA200: ${escape(lastSnap.emaLong.toFixed(6))}`,
        `• MACD: ${escape(lastSnap.macdLine.toFixed(6))} / signal ${escape(lastSnap.macdSignal.toFixed(6))} / hist ${escape(lastSnap.macdHistogram.toFixed(6))}`,
        `• BB: ${escape(lastSnap.bbLower.toFixed(6))} – ${escape(lastSnap.bbMiddle.toFixed(6))} – ${escape(lastSnap.bbUpper.toFixed(6))}  \\(%B ${escape(lastSnap.percentB.toFixed(3))}\\)`,
        `• Stoch K/D: ${escape(lastSnap.stochasticK.toFixed(2))} / ${escape(lastSnap.stochasticD.toFixed(2))}`,
        `• Momentum: ${escape(lastSnap.momentum.toFixed(4))}  VWMA: ${escape(lastSnap.vwma.toFixed(6))}  VWAP: ${escape(lastSnap.vwap.toFixed(6))}`,
        ``,
    ];

    try {
        await telegram.sendMessage(lines.join('\n'), {
            parse_mode: 'MarkdownV2',
        });
        await dbService.recordTrendingNotification(symbol, now);
        logger.info('Trending notification sent', { symbol });
        return true;
    } catch (err) {
        logger.error('Failed to send trending notification', {
            symbol,
            error: err instanceof Error ? err.message : String(err),
        });
        return false;
    }
}
