// src/lib/watchAlerts/conditions/seriesCache.ts
// Per-(symbol, timeframe) IndicatorMap cache for one evaluation pass.
// Fetches OHLCV once per timeframe and runs computeIndicators() once.

import { createLogger } from '../../../logger';
import { config } from '../../../config/settings';
import type { ExchangeService } from '../../exchange';
import {
    computeIndicators,
    type IndicatorMap,
} from '../../../utils/indicatorUtils';
import type { OhlcvData } from '../../../../types';

const logger = createLogger('WatchAlerts.SeriesCache');

/**
 * Maps a leaf indicator name (+ optional period) onto a numeric series
 * from the IndicatorMap produced by computeIndicators().
 *
 * Periods are fixed inside computeIndicators; non-standard periods return
 * undefined (fail-closed at the leaf evaluator).
 *
 * ADX is only populated on the HTF side of computeIndicators. We always
 * pass the same OHLCV as both primary and htf so ADX is available for
 * every timeframe we evaluate.
 */
export function resolveSeries(
    map: IndicatorMap,
    indicator: string,
    period?: number
): number[] | undefined {
    const key = indicator.toLowerCase();

    switch (key) {
        case 'close':
            return map.close;
        case 'high':
            return map.high;
        case 'low':
            return map.low;
        case 'volume':
            return map.volume;
        case 'rsi':
            // Fixed period 14 in computeIndicators
            if (period !== undefined && period !== 14) return undefined;
            return map.rsi;
        case 'ema':
            if (period === 20 || period === undefined) return map.emaShort;
            if (period === 50) return map.emaMid;
            if (period === 200) return map.emaLong;
            return undefined;
        case 'sma':
            if (period !== undefined && period !== 20) return undefined;
            return map.sma;
        case 'macd_line':
            return map.macd.line;
        case 'macd_signal':
            return map.macd.signal;
        case 'macd_histogram':
            return map.macd.histogram;
        case 'atr':
            if (period !== undefined && period !== 14) return undefined;
            return map.atr;
        case 'adx':
            return map.htfAdx?.adx;
        case 'obv':
            return map.obv;
        case 'vwma':
            if (period !== undefined && period !== 20) return undefined;
            return map.vwma;
        case 'vwap':
            return map.vwap;
        case 'momentum':
            if (period !== undefined && period !== 10) return undefined;
            return map.momentum;
        case 'stoch_k':
            return map.stochastic?.k;
        case 'stoch_d':
            return map.stochastic?.d;
        case 'bb_upper':
            return map.bollingerBands?.upper;
        case 'bb_middle':
            return map.bollingerBands?.middle;
        case 'bb_lower':
            return map.bollingerBands?.lower;
        case 'percent_b':
            return map.bollingerBands?.percentB;
        default:
            return undefined;
    }
}

/**
 * One evaluation-pass cache keyed by timeframe.
 * Created fresh for each alert evaluation (or shared across alerts in a cycle
 * when the caller reuses the instance for the same symbol).
 */
export class SeriesCache {
    private readonly cache = new Map<string, IndicatorMap>();
    private readonly ohlcvCache = new Map<string, OhlcvData>();

    constructor(
        private readonly exchange: ExchangeService,
        private readonly symbol: string
    ) { }

    /**
     * Returns IndicatorMap for the requested timeframe, fetching + computing
     * at most once per timeframe for the lifetime of this cache instance.
     */
    async get(timeframe: string): Promise<IndicatorMap | null> {
        const existing = this.cache.get(timeframe);
        if (existing) return existing;

        try {
            const data = await this.exchange.getOHLCV(
                this.symbol,
                timeframe,
                undefined,
                undefined,
                false
            );

            if (!data || data.closes.length < config.historyLength) {
                logger.debug('Insufficient OHLCV for series cache', {
                    symbol: this.symbol,
                    timeframe,
                    length: data?.closes.length ?? 0,
                });
                return null;
            }

            // Pass the same series as HTF so ADX / HTF fields are populated
            // for this timeframe without a second fetch.
            const map = computeIndicators(data, data);
            this.cache.set(timeframe, map);
            this.ohlcvCache.set(timeframe, data);
            return map;
        } catch (err) {
            logger.debug('Series cache fetch failed', {
                symbol: this.symbol,
                timeframe,
                error: err instanceof Error ? err.message : String(err),
            });
            return null;
        }
    }

    /** Latest close for a timeframe (for trade-plan resolution / progress). */
    async getLastClose(timeframe: string): Promise<number | null> {
        const map = await this.get(timeframe);
        if (!map) return null;
        return map.last?.close ?? map.close?.at(-1) ?? null;
    }

    /** Latest ATR for a timeframe (defaults used by resolveTradePlan). */
    async getLastAtr(timeframe: string): Promise<number | null> {
        const map = await this.get(timeframe);
        if (!map) return null;
        return map.last?.atr ?? map.atr?.at(-1) ?? null;
    }

    /** Expose raw map when already loaded (sync path for progress display). */
    getCached(timeframe: string): IndicatorMap | null {
        return this.cache.get(timeframe) ?? null;
    }
}
