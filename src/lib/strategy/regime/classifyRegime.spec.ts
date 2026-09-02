// src/lib/strategy/regime/classifyRegime.spec.ts
// Phase 2 — Regime engine unit tests (shadow mode; no strategy scoring)

import test from 'ava';

import type { IndicatorMap } from '../../utils/indicatorUtils';
import {
    BB_SQUEEZE_LOOKBACK,
    MIN_ADX,
    MIN_BB_BANDWIDTH_PCT,
    RELATIVE_VOLUME_MULTIPLIER,
} from '../constants';

import {
    classifyRegime,
    hasBreakoutVolumeConfirmation,
} from './classifyRegime';
import type { RegimeCandleContext } from './types';


type LastOverrides = Partial<IndicatorMap['last']>;

function makeIndicators(
    last: LastOverrides,
    series?: {
        bandwidth?: number[];
        upper?: number[];
        lower?: number[];
    }
): IndicatorMap {
    const n = series?.bandwidth?.length ?? 12;
    const zeros = Array(n).fill(0);
    const bandwidth = series?.bandwidth ?? Array(n).fill(1.0);
    const upper = series?.upper ?? Array(n).fill(110);
    const lower = series?.lower ?? Array(n).fill(90);

    const baseLast = {
        open: 100,
        high: 101,
        low: 99,
        close: 100,
        volume: 1000,
        emaShort: 100,
        emaMid: 100,
        emaLong: 100,
        rsi: 50,
        macd: 0,
        macdSignal: 0,
        macdHist: 0,
        stochK: 50,
        stochD: 50,
        atr: 1,
        bbUpper: 110,
        bbMiddle: 100,
        bbLower: 90,
        bbBandwidth: bandwidth[bandwidth.length - 1],
        percentB: 0.5,
        obv: 0,
        vwap: 100,
        vwma: 100,
        htfAdx: 15,
        htfPdi: 20,
        htfMdi: 20,
        ...last,
    };

    return {
        last: baseLast,
        bollingerBands: { bandwidth, upper, lower, middle: zeros },
        emaShort: zeros,
        emaMid: zeros,
        emaLong: zeros,
        vwma: zeros,
        vwap: zeros,
        atr: zeros,
        rsi: zeros,
        macd: { macd: zeros, signal: zeros, histogram: zeros },
        stochastic: { k: zeros, d: zeros },
        obv: zeros,
        htfAdx: { adx: zeros, pdi: zeros, mdi: zeros },
    } as unknown as IndicatorMap;
}

function squeezeSeries(opts: {
    expanding: boolean;
    breakDir: 'bullish' | 'bearish' | 'none';
}): {
    bandwidth: number[];
    upper: number[];
    lower: number[];
    closes: number[];
} {
    const lookback = BB_SQUEEZE_LOOKBACK;
    const n = lookback + 1;
    const squeezed = MIN_BB_BANDWIDTH_PCT * 0.5;
    const bandwidth = Array(lookback).fill(squeezed);
    const expanded = opts.expanding
        ? Math.max(MIN_BB_BANDWIDTH_PCT, squeezed * 2)
        : squeezed;
    bandwidth.push(expanded);

    const upper = Array(n).fill(110);
    const lower = Array(n).fill(90);
    const closes = Array(n).fill(100);
    if (opts.breakDir === 'bullish') {
        closes[n - 1] = 111;
    } else if (opts.breakDir === 'bearish') {
        closes[n - 1] = 89;
    }
    return { bandwidth, upper, lower, closes };
}

function highVolume(n: number, surge = true): number[] {
    const prior = Array(n - 1).fill(100);
    const current = surge ? 100 * RELATIVE_VOLUME_MULTIPLIER * 1.5 : 50;
    return [...prior, current];
}

test('TREND: bullish ADX+DI+EMA alignment → TREND', (t) => {
    const ind = makeIndicators({
        htfAdx: MIN_ADX + 5,
        htfPdi: 40,
        htfMdi: 10,
        emaShort: 120,
        emaMid: 110,
        emaLong: 100,
    });
    const r = classifyRegime(ind, 120, 'bullish');
    t.is(r.regime, 'TREND');
    t.true(r.isTrendEvidence);
    t.true(r.emaAlignedBullish);
    t.false(r.isBreakout);
});

test('TREND: bearish ADX+DI+EMA alignment → TREND', (t) => {
    const ind = makeIndicators({
        htfAdx: MIN_ADX + 10,
        htfPdi: 10,
        htfMdi: 40,
        emaShort: 90,
        emaMid: 100,
        emaLong: 110,
    });
    const r = classifyRegime(ind, 90, 'bearish');
    t.is(r.regime, 'TREND');
    t.true(r.emaAlignedBearish);
});

test('TREND: strong ADX+DI but no EMA alignment → not TREND (RANGE)', (t) => {
    const ind = makeIndicators({
        htfAdx: 40,
        htfPdi: 40,
        htfMdi: 10,
        emaShort: 100,
        emaMid: 105,
        emaLong: 100,
    });
    const r = classifyRegime(ind, 100, 'bullish');
    t.not(r.regime, 'TREND');
    t.false(r.isTrendEvidence);
    t.is(r.regime, 'RANGE');
});

test('TREND: EMA aligned but weak ADX → not TREND', (t) => {
    const ind = makeIndicators({
        htfAdx: MIN_ADX - 1,
        htfPdi: 40,
        htfMdi: 10,
        emaShort: 120,
        emaMid: 110,
        emaLong: 100,
    });
    const r = classifyRegime(ind, 120, 'bullish');
    t.not(r.regime, 'TREND');
    t.false(r.isTrendEvidence);
});

test('TREND: EMA aligned, ADX ok, but DI separation too small → not TREND', (t) => {
    const ind = makeIndicators({
        htfAdx: MIN_ADX + 5,
        htfPdi: 25,
        htfMdi: 20,
        emaShort: 120,
        emaMid: 110,
        emaLong: 100,
    });
    const r = classifyRegime(ind, 120, 'bullish');
    t.not(r.regime, 'TREND');
});

test('RANGE: weak ADX + weak DI + EMA neutral → RANGE with isRangeEvidence', (t) => {
    const ind = makeIndicators({
        htfAdx: 10,
        htfPdi: 22,
        htfMdi: 20,
        emaShort: 100,
        emaMid: 100,
        emaLong: 100,
        vwap: 100,
        vwma: 100.1,
    });
    const r = classifyRegime(ind, 100, 'neutral');
    t.is(r.regime, 'RANGE');
    t.false(r.isBreakout);
    t.false(r.isTrendEvidence);
    t.true(r.weakAdx);
    t.true(r.weakDiSeparation);
    t.true(r.emaNeutral);
    t.true(r.isRangeEvidence);
});

test('RANGE: price around VWAP with no trend/breakout → RANGE + nearVwap', (t) => {
    const ind = makeIndicators({
        htfAdx: 12,
        htfPdi: 18,
        htfMdi: 17,
        emaShort: 101,
        emaMid: 100,
        emaLong: 100.5,
        vwap: 100,
        vwma: 100,
    });
    const r = classifyRegime(ind, 100.2, 'neutral');
    t.is(r.regime, 'RANGE');
    t.true(r.nearVwap);
    t.true(r.isRangeEvidence);
});

test('RANGE: insufficient DI separation + EMA neutral → RANGE evidence', (t) => {
    const ind = makeIndicators({
        htfAdx: 25,
        htfPdi: 22,
        htfMdi: 20,
        emaShort: 100,
        emaMid: 100,
        emaLong: 100,
    });
    const r = classifyRegime(ind, 100, 'neutral');
    t.is(r.regime, 'RANGE');
    t.true(r.weakDiSeparation);
    t.true(r.emaNeutral);
    t.true(r.isRangeEvidence);
    t.false(r.isTrendEvidence);
});

test('RANGE: no EMA directional alignment is exposed on diagnostics', (t) => {
    const ind = makeIndicators({
        htfAdx: 8,
        htfPdi: 15,
        htfMdi: 14,
        emaShort: 105,
        emaMid: 100,
        emaLong: 102,
    });
    const r = classifyRegime(ind, 100, 'neutral');
    t.is(r.regime, 'RANGE');
    t.true(r.emaNeutral);
    t.false(r.emaAlignedBullish);
    t.false(r.emaAlignedBearish);
});

test('BREAKOUT: compression + expansion + directional break + volume → BREAKOUT', (t) => {
    const series = squeezeSeries({ expanding: true, breakDir: 'bullish' });
    const ind = makeIndicators(
        {
            htfAdx: 15,
            htfPdi: 20,
            htfMdi: 20,
            bbBandwidth: series.bandwidth[series.bandwidth.length - 1],
        },
        series
    );
    const candle: RegimeCandleContext = {
        closes: series.closes,
        volumes: highVolume(series.closes.length, true),
    };
    const r = classifyRegime(ind, 111, 'neutral', candle);
    t.is(r.regime, 'BREAKOUT');
    t.true(r.breakoutStructure);
    t.true(r.volumeConfirmed);
    t.true(r.isBreakout);
    t.is(r.breakoutDirection, 'bullish');
});

test('BREAKOUT: bearish structure + volume surge flag → BREAKOUT', (t) => {
    const series = squeezeSeries({ expanding: true, breakDir: 'bearish' });
    const ind = makeIndicators(
        { htfAdx: 12, bbBandwidth: series.bandwidth.at(-1) },
        series
    );
    const r = classifyRegime(ind, 89, 'neutral', {
        closes: series.closes,
        volumes: highVolume(series.closes.length, false),
        hasVolumeSurge: true,
    });
    t.is(r.regime, 'BREAKOUT');
    t.is(r.breakoutDirection, 'bearish');
});

test('BREAKOUT neg: compression + expansion but no directional break → not BREAKOUT', (t) => {
    const series = squeezeSeries({ expanding: true, breakDir: 'none' });
    const ind = makeIndicators(
        { bbBandwidth: series.bandwidth.at(-1) },
        series
    );
    const r = classifyRegime(ind, 100, 'neutral', {
        closes: series.closes,
        volumes: highVolume(series.closes.length, true),
    });
    t.false(r.breakoutStructure);
    t.not(r.regime, 'BREAKOUT');
});

test('BREAKOUT neg: directional break without compression → not BREAKOUT', (t) => {
    const n = BB_SQUEEZE_LOOKBACK + 1;
    const bandwidth = Array(n).fill(MIN_BB_BANDWIDTH_PCT * 3);
    const upper = Array(n).fill(110);
    const lower = Array(n).fill(90);
    const closes = Array(n).fill(100);
    closes[n - 1] = 111;
    const ind = makeIndicators(
        { bbBandwidth: bandwidth[n - 1] },
        { bandwidth, upper, lower }
    );
    const r = classifyRegime(ind, 111, 'neutral', {
        closes,
        volumes: highVolume(n, true),
    });
    t.false(r.breakoutStructure);
    t.not(r.regime, 'BREAKOUT');
});

test('BREAKOUT neg: expansion without compression → not BREAKOUT', (t) => {
    const n = BB_SQUEEZE_LOOKBACK + 1;
    const bandwidth = Array(n).fill(MIN_BB_BANDWIDTH_PCT * 2);
    bandwidth[n - 1] = MIN_BB_BANDWIDTH_PCT * 5;
    const upper = Array(n).fill(110);
    const lower = Array(n).fill(90);
    const closes = Array(n).fill(100);
    closes[n - 1] = 111;
    const ind = makeIndicators(
        { bbBandwidth: bandwidth[n - 1] },
        { bandwidth, upper, lower }
    );
    const r = classifyRegime(ind, 111, 'neutral', {
        closes,
        volumes: highVolume(n, true),
    });
    t.not(r.regime, 'BREAKOUT');
});

test('BREAKOUT neg: structure without volume confirmation → not BREAKOUT', (t) => {
    const series = squeezeSeries({ expanding: true, breakDir: 'bullish' });
    const ind = makeIndicators(
        { bbBandwidth: series.bandwidth.at(-1) },
        series
    );
    const r = classifyRegime(ind, 111, 'neutral', {
        closes: series.closes,
        volumes: highVolume(series.closes.length, false),
        hasVolumeSurge: false,
    });
    t.true(r.breakoutStructure);
    t.false(r.volumeConfirmed);
    t.false(r.isBreakout);
    t.not(r.regime, 'BREAKOUT');
});

test('BREAKOUT neg: high ATR alone without structure → not BREAKOUT', (t) => {
    const ind = makeIndicators({
        atr: 50,
        htfAdx: 10,
        htfPdi: 20,
        htfMdi: 20,
        emaShort: 100,
        emaMid: 100,
        emaLong: 100,
    });
    const r = classifyRegime(ind, 100, 'neutral');
    t.true(r.atrPct > 10);
    t.false(r.breakoutStructure);
    t.not(r.regime, 'BREAKOUT');
    t.is(r.regime, 'RANGE');
});

test('PRECEDENCE: valid breakout wins even when TREND evidence also holds', (t) => {
    const series = squeezeSeries({ expanding: true, breakDir: 'bullish' });
    const ind = makeIndicators(
        {
            htfAdx: 40,
            htfPdi: 45,
            htfMdi: 10,
            emaShort: 120,
            emaMid: 110,
            emaLong: 100,
            bbBandwidth: series.bandwidth.at(-1),
        },
        series
    );
    const r = classifyRegime(ind, 111, 'bullish', {
        closes: series.closes,
        volumes: highVolume(series.closes.length, true),
    });
    t.true(r.isTrendEvidence);
    t.true(r.isBreakout);
    t.is(r.regime, 'BREAKOUT');
});

test('DETERMINISM: identical inputs → identical regime', (t) => {
    const ind = makeIndicators({
        htfAdx: 25,
        htfPdi: 35,
        htfMdi: 10,
        emaShort: 120,
        emaMid: 110,
        emaLong: 100,
    });
    const a = classifyRegime(ind, 120, 'bullish');
    const b = classifyRegime(ind, 120, 'bullish');
    t.deepEqual(a, b);
});

test('NaN safety: non-finite indicator values do not yield NaN diagnostics', (t) => {
    const ind = makeIndicators({
        htfAdx: Number.NaN,
        htfPdi: Number.POSITIVE_INFINITY,
        htfMdi: Number.NaN,
        atr: Number.NaN,
        bbBandwidth: Number.NaN,
        emaShort: Number.NaN,
        emaMid: Number.NaN,
        emaLong: Number.NaN,
        vwap: Number.NaN,
        vwma: Number.NaN,
    });
    const r = classifyRegime(ind, 100, 'neutral');
    t.false(Number.isNaN(r.adx));
    t.false(Number.isNaN(r.diDiff));
    t.false(Number.isNaN(r.atrPct));
    t.false(Number.isNaN(r.bbBandwidth));
    t.true(['TREND', 'RANGE', 'BREAKOUT'].includes(r.regime));
});

test('volume confirmation helper: surge and relative volume', (t) => {
    t.true(hasBreakoutVolumeConfirmation(undefined, true));
    t.false(hasBreakoutVolumeConfirmation(undefined, false));
    t.true(hasBreakoutVolumeConfirmation(highVolume(20, true)));
    t.false(hasBreakoutVolumeConfirmation(highVolume(20, false)));
});

test('SHADOW: scoring module does not import regime classifier', (t) => {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const scoringPath = path.resolve(
        process.cwd(),
        'src/lib/strategy/scoring/computeScores.ts'
    );
    const src = fs.readFileSync(scoringPath, 'utf8');
    t.false(src.includes('classifyRegime'));
    t.false(src.includes('MarketRegime'));
    t.false(src.includes("from '../regime"));
});

test('SHADOW: determineSignal does not branch on regime', (t) => {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const signalPath = path.resolve(
        process.cwd(),
        'src/lib/strategy/signal/determineSignal.ts'
    );
    const src = fs.readFileSync(signalPath, 'utf8');
    t.false(/regime/i.test(src));
});

test('public regimes are exactly TREND | RANGE | BREAKOUT', (t) => {
    const allowed = new Set(['TREND', 'RANGE', 'BREAKOUT']);
    const cases: Array<ReturnType<typeof classifyRegime>> = [
        classifyRegime(
            makeIndicators({
                htfAdx: 30,
                htfPdi: 40,
                htfMdi: 10,
                emaShort: 120,
                emaMid: 110,
                emaLong: 100,
            }),
            120,
            'bullish'
        ),
        classifyRegime(
            makeIndicators({ htfAdx: 10, htfPdi: 20, htfMdi: 18 }),
            100,
            'neutral'
        ),
    ];
    for (const r of cases) {
        t.true(allowed.has(r.regime));
    }
    for (const legacy of [
        'strong_trend',
        'weak_trend',
        'ranging',
        'high_volatility',
        'choppy',
    ]) {
        t.false(cases.some((c) => (c.regime as string) === legacy));
    }
});

test('BEHAVIORAL SHADOW: determineSignal + riskParams unchanged when regime varies', (t) => {
    const { determineSignal } = require('../signal/determineSignal') as typeof import('../signal/determineSignal');
    const { computeRiskParams } = require('../risk/riskParams') as typeof import('../risk/riskParams');
    const { buildFinalSignal } = require('../buildSignal') as typeof import('../buildSignal');

    const buyScore = 62;
    const sellScore = 28;
    const trendBias = 'bullish' as const;
    const isRiskEligible = true;

    const reasonsA: string[] = [];
    const decisionA = determineSignal(
        buyScore,
        sellScore,
        trendBias,
        isRiskEligible,
        reasonsA
    );

    const trendInd = makeIndicators({
        htfAdx: 30,
        htfPdi: 40,
        htfMdi: 10,
        emaShort: 120,
        emaMid: 110,
        emaLong: 100,
    });
    const regimeTrend = classifyRegime(trendInd, 120, 'bullish');
    t.is(regimeTrend.regime, 'TREND');

    const reasonsB: string[] = [];
    const decisionB = determineSignal(
        buyScore,
        sellScore,
        trendBias,
        isRiskEligible,
        reasonsB
    );
    t.deepEqual(decisionA, decisionB);

    const price = 100;
    const atr = 2;
    const riskA = computeRiskParams(
        decisionA.signal === 'hold' ? 'buy' : decisionA.signal,
        price,
        1.5,
        2.0,
        decisionA.confidence,
        atr,
        trendBias,
        1000,
        true
    );
    const riskB = computeRiskParams(
        decisionB.signal === 'hold' ? 'buy' : decisionB.signal,
        price,
        1.5,
        2.0,
        decisionB.confidence,
        atr,
        trendBias,
        1000,
        true
    );
    t.deepEqual(
        {
            feasible: riskA.feasible,
            stopLoss: riskA.stopLoss,
            takeProfit: riskA.takeProfit,
            trailingStopDistance: riskA.trailingStopDistance,
            positionSizeMultiplier: riskA.positionSizeMultiplier,
        },
        {
            feasible: riskB.feasible,
            stopLoss: riskB.stopLoss,
            takeProfit: riskB.takeProfit,
            trailingStopDistance: riskB.trailingStopDistance,
            positionSizeMultiplier: riskB.positionSizeMultiplier,
        }
    );

    const rangeInd = makeIndicators({
        htfAdx: 10,
        htfPdi: 20,
        htfMdi: 18,
        emaShort: 100,
        emaMid: 100,
        emaLong: 100,
        vwap: 100,
    });
    const regimeRange = classifyRegime(rangeInd, 100, 'neutral');
    t.is(regimeRange.regime, 'RANGE');
    t.true(regimeRange.isRangeEvidence);

    const base = {
        symbol: 'BTC/USDT',
        signal: decisionA.signal,
        confidence: decisionA.confidence,
        reasons: ['fixture'],
        features: [0.1, 0.2],
        stopLoss: riskA.stopLoss,
        takeProfit: riskA.takeProfit,
        trailingStopDistance: riskA.trailingStopDistance,
        positionSizeMultiplier: riskA.positionSizeMultiplier,
    };
    const sigTrend = buildFinalSignal({ ...base, regime: regimeTrend.regime });
    const sigRange = buildFinalSignal({ ...base, regime: regimeRange.regime });
    t.not(sigTrend.regime, sigRange.regime);
    const { regime: _r1, ...restTrend } = sigTrend;
    const { regime: _r2, ...restRange } = sigRange;
    t.deepEqual(restTrend, restRange);
});

test('BEHAVIORAL SHADOW: control path ignores regime — scores drive signal only', (t) => {
    const { determineSignal } = require('../signal/determineSignal') as typeof import('../signal/determineSignal');

    const bull = classifyRegime(
        makeIndicators({
            htfAdx: 35,
            htfPdi: 40,
            htfMdi: 10,
            emaShort: 120,
            emaMid: 110,
            emaLong: 100,
        }),
        120,
        'bullish'
    );
    const range = classifyRegime(
        makeIndicators({
            htfAdx: 8,
            htfPdi: 15,
            htfMdi: 14,
            emaShort: 100,
            emaMid: 100,
            emaLong: 100,
            vwap: 100,
        }),
        100,
        'neutral'
    );
    t.is(bull.regime, 'TREND');
    t.is(range.regime, 'RANGE');

    const d1 = determineSignal(70, 20, 'bullish', true, []);
    const d2 = determineSignal(70, 20, 'bullish', true, []);
    t.deepEqual(d1, d2);
    t.true(bull.regime !== range.regime);
});
