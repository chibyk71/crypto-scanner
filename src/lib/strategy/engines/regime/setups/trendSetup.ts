// TREND continuation / pullback setup + entry trigger.
//
// Hypothesis (not tuned on simulated_trades.csv):
//   Established directional trend → pullback into fast MA zone →
//   continuation confirmation → entry in trend direction.
//
// Regime alone is NOT an entry.
// All conditions use current or previously closed candle data only.

import type { IndicatorMap } from '../../../../utils/indicatorUtils';
import type { SetupContext, SetupResult } from '../../types';
import { emptySetupResult } from '../../types';

/**
 * Fixed structural lookback for pullback evidence on PRIOR candles only
 * (excludes the decision candle). Not optimized against trade outcomes.
 *
 * Temporal invariant: pullback is established on bars < decision index;
 * the decision candle may only provide the continuation trigger / invalidation.
 */
const PULLBACK_LOOKBACK_BARS = 5;

function seriesLen(indicators: IndicatorMap): number {
    return Math.min(
        indicators.close.length,
        indicators.emaShort.length,
        indicators.emaMid.length,
        indicators.low.length,
        indicators.high.length,
        indicators.macd.histogram.length
    );
}

/**
 * Bullish pullback on PRIOR candles only: within lookback ending at n-2,
 * at least one bar traded at/below emaShort while structure held
 * (low stayed above emaMid). Decision candle is excluded.
 */
function hasBullishPullback(indicators: IndicatorMap, n: number): boolean {
    // Decision candle is index n-1; pullback may only use bars before it.
    if (n < 2) {
        return false;
    }
    const decisionIdx = n - 1;
    const start = Math.max(0, decisionIdx - PULLBACK_LOOKBACK_BARS);
    let touchedFastMa = false;
    for (let i = start; i < decisionIdx; i++) {
        const low = indicators.low[i];
        const emaS = indicators.emaShort[i];
        const emaM = indicators.emaMid[i];
        if (!Number.isFinite(low) || !Number.isFinite(emaS) || !Number.isFinite(emaM)) {
            continue;
        }
        // Structure broken inside prior window → not a clean pullback
        if (low < emaM) {
            return false;
        }
        if (low <= emaS) {
            touchedFastMa = true;
        }
    }
    return touchedFastMa;
}

/**
 * Bearish pullback on PRIOR candles only: within lookback ending at n-2,
 * at least one bar traded at/above emaShort while structure held
 * (high stayed below emaMid). Decision candle is excluded.
 */
function hasBearishPullback(indicators: IndicatorMap, n: number): boolean {
    // Decision candle is index n-1; pullback may only use bars before it.
    if (n < 2) {
        return false;
    }
    const decisionIdx = n - 1;
    const start = Math.max(0, decisionIdx - PULLBACK_LOOKBACK_BARS);
    let touchedFastMa = false;
    for (let i = start; i < decisionIdx; i++) {
        const high = indicators.high[i];
        const emaS = indicators.emaShort[i];
        const emaM = indicators.emaMid[i];
        if (!Number.isFinite(high) || !Number.isFinite(emaS) || !Number.isFinite(emaM)) {
            continue;
        }
        if (high > emaM) {
            return false;
        }
        if (high >= emaS) {
            touchedFastMa = true;
        }
    }
    return touchedFastMa;
}

/**
 * Continuation trigger: price has reclaimed the fast MA and short-term MACD
 * momentum agrees with the trend direction (histogram turning with the trend).
 * Uses current and previous closed histogram values only.
 */
function bullishContinuationTrigger(indicators: IndicatorMap, n: number): boolean {
    if (n < 2) return false;
    const close = indicators.close[n - 1];
    const emaS = indicators.emaShort[n - 1];
    const hist = indicators.macd.histogram;
    const h0 = hist[n - 1];
    const h1 = hist[n - 2];
    if (
        !Number.isFinite(close) ||
        !Number.isFinite(emaS) ||
        !Number.isFinite(h0) ||
        !Number.isFinite(h1)
    ) {
        return false;
    }
    const reclaimedFastMa = close > emaS;
    const macdTurningUp = h0 > h1;
    return reclaimedFastMa && macdTurningUp;
}

function bearishContinuationTrigger(indicators: IndicatorMap, n: number): boolean {
    if (n < 2) return false;
    const close = indicators.close[n - 1];
    const emaS = indicators.emaShort[n - 1];
    const hist = indicators.macd.histogram;
    const h0 = hist[n - 1];
    const h1 = hist[n - 2];
    if (
        !Number.isFinite(close) ||
        !Number.isFinite(emaS) ||
        !Number.isFinite(h0) ||
        !Number.isFinite(h1)
    ) {
        return false;
    }
    const rejectedFastMa = close < emaS;
    const macdTurningDown = h0 < h1;
    return rejectedFastMa && macdTurningDown;
}

/**
 * Detect TREND continuation/pullback setup with explicit entry trigger.
 *
 * Does not trade merely because regime === TREND.
 */
export function detectTrendSetup(ctx: SetupContext): SetupResult {
    const { classification, indicators, price } = ctx;
    const reasons: string[] = [];
    const diagnostics: SetupResult['diagnostics'] = {
        regime: classification.regime,
        isTrendEvidence: classification.isTrendEvidence,
        emaAlignedBullish: classification.emaAlignedBullish,
        emaAlignedBearish: classification.emaAlignedBearish,
        trendBias: classification.trendBias,
        adx: classification.adx,
        diDiff: classification.diDiff,
        price,
        emaShort: indicators.last.emaShort,
        emaMid: indicators.last.emaMid,
    };

    if (classification.regime !== 'TREND') {
        reasons.push('trend setup: regime is not TREND');
        return emptySetupResult({ reasons, diagnostics });
    }

    if (!classification.isTrendEvidence) {
        reasons.push('trend setup: isTrendEvidence is false');
        return emptySetupResult({ reasons, diagnostics });
    }

    // Direction must be internally consistent (EMA stack + HTF bias).
    const longOk =
        classification.emaAlignedBullish && classification.trendBias === 'bullish';
    const shortOk =
        classification.emaAlignedBearish && classification.trendBias === 'bearish';

    if (longOk && shortOk) {
        reasons.push('trend setup: contradictory long and short direction');
        return emptySetupResult({ reasons, diagnostics });
    }
    if (!longOk && !shortOk) {
        reasons.push(
            'trend setup: no consistent direction (EMA alignment vs trendBias)'
        );
        return emptySetupResult({ reasons, diagnostics });
    }

    const side = longOk ? 'buy' : 'sell';
    const setupId =
        side === 'buy' ? 'trend_continuation_long' : 'trend_continuation_short';

    const n = seriesLen(indicators);
    diagnostics.seriesLen = n;

    // ---- Invalidation: mid-trend structure broken on decision candle ----
    const emaMid = indicators.last.emaMid;
    if (Number.isFinite(emaMid)) {
        if (side === 'buy' && price < emaMid) {
            const inv = 'trend setup invalidated: price below emaMid (long structure broken)';
            reasons.push(inv);
            return emptySetupResult({
                reasons,
                diagnostics,
                setupQualified: false,
                entryTriggered: false,
                invalidation: inv,
                setupId,
            });
        }
        if (side === 'sell' && price > emaMid) {
            const inv = 'trend setup invalidated: price above emaMid (short structure broken)';
            reasons.push(inv);
            return emptySetupResult({
                reasons,
                diagnostics,
                setupQualified: false,
                entryTriggered: false,
                invalidation: inv,
                setupId,
            });
        }
    }

    // ---- Setup qualification: pullback within the established trend ----
    const pullback =
        side === 'buy'
            ? hasBullishPullback(indicators, n)
            : hasBearishPullback(indicators, n);
    diagnostics.pullback = pullback;

    if (!pullback) {
        reasons.push(
            `trend setup: no pullback into fast-MA zone within ${PULLBACK_LOOKBACK_BARS} bars`
        );
        return emptySetupResult({
            reasons,
            diagnostics,
            setupQualified: false,
            entryTriggered: false,
            setupId,
            side: null,
        });
    }

    reasons.push(
        `trend setup: pullback qualified (${side === 'buy' ? 'long' : 'short'})`
    );

    // ---- Entry trigger: reclaim/reject fast MA + MACD histogram turn ----
    const triggered =
        side === 'buy'
            ? bullishContinuationTrigger(indicators, n)
            : bearishContinuationTrigger(indicators, n);
    diagnostics.entryTriggered = triggered;
    if (n >= 2) {
        diagnostics.macdHistNow = indicators.macd.histogram[n - 1] ?? null;
        diagnostics.macdHistPrev = indicators.macd.histogram[n - 2] ?? null;
    }

    if (!triggered) {
        reasons.push(
            'trend setup: pullback present but continuation trigger not fired'
        );
        return emptySetupResult({
            reasons,
            diagnostics,
            setupQualified: true,
            entryTriggered: false,
            setupId,
            side: null,
        });
    }

    reasons.push(
        `trend setup: continuation trigger fired → ${side === 'buy' ? 'long' : 'short'} entry`
    );

    return {
        detected: true,
        setupId,
        side,
        setupQualified: true,
        entryTriggered: true,
        invalidation: null,
        reasons,
        diagnostics,
    };
}
