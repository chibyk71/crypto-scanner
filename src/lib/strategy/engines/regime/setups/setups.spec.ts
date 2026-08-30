// Phase 3 — explicit setup + entry-trigger tests
// Rules are structural hypotheses, not tuned on simulated_trades.csv.

import test from 'ava';
import type { IndicatorMap } from '../../../../utils/indicatorUtils';
import type { RegimeClassification } from '../../../regime/types';
import type { SetupContext } from '../../types';
import { detectBreakoutSetup } from './breakoutSetup';
import { detectRangeSetup } from './rangeSetup';
import { detectTrendSetup } from './trendSetup';
import { detectSetupForRegime } from './index';

function baseClassification(
    overrides: Partial<RegimeClassification> = {}
): RegimeClassification {
    return {
        regime: 'RANGE',
        adx: 10,
        pdi: 20,
        mdi: 18,
        diDiff: 2,
        emaAlignedBullish: false,
        emaAlignedBearish: false,
        emaNeutral: true,
        vwmaAboveVwap: false,
        nearVwap: true,
        trendBias: 'neutral',
        isTrendEvidence: false,
        weakAdx: true,
        weakDiSeparation: true,
        isRangeEvidence: true,
        atrPct: 1,
        bbBandwidth: 1,
        breakoutStructure: false,
        breakoutDirection: null,
        volumeConfirmed: false,
        isBreakout: false,
        ...overrides,
    };
}

function buildIndicators(opts: {
    n?: number;
    closes?: number[];
    lows?: number[];
    highs?: number[];
    emaShort?: number[];
    emaMid?: number[];
    macdHist?: number[];
    bbUpper?: number[];
    bbLower?: number[];
    bbMiddle?: number[];
}): IndicatorMap {
    const n = opts.n ?? opts.closes?.length ?? 8;
    const closes = opts.closes ?? Array.from({ length: n }, (_, i) => 100 + i * 0.1);
    const emaShort = opts.emaShort ?? Array.from({ length: n }, () => 100);
    const emaMid = opts.emaMid ?? Array.from({ length: n }, () => 98);
    const lows = opts.lows ?? closes.map((c, i) => Math.min(c, emaShort[i]) - 0.01);
    const highs = opts.highs ?? closes.map((c, i) => Math.max(c, emaShort[i]) + 0.01);
    const macdHist = opts.macdHist ?? Array.from({ length: n }, () => 0);
    const bbUpper = opts.bbUpper ?? Array.from({ length: n }, () => 105);
    const bbLower = opts.bbLower ?? Array.from({ length: n }, () => 95);
    const bbMiddle = opts.bbMiddle ?? Array.from({ length: n }, () => 100);
    const zeros = Array.from({ length: n }, () => 0);
    const lastIdx = n - 1;
    return {
        close: closes,
        high: highs,
        low: lows,
        open: closes.slice(),
        volume: Array.from({ length: n }, () => 1000),
        sma: zeros.slice(),
        emaShort,
        emaMid,
        emaLong: emaMid.slice(),
        vwma: zeros.slice(),
        vwap: zeros.slice(),
        rsi: zeros.slice(),
        momentum: zeros.slice(),
        stochastic: { k: zeros.slice(), d: zeros.slice() },
        macd: { line: zeros.slice(), signal: zeros.slice(), histogram: macdHist },
        atr: Array.from({ length: n }, () => 1),
        bollingerBands: {
            upper: bbUpper,
            middle: bbMiddle,
            lower: bbLower,
            bandwidth: zeros.slice(),
            percentB: zeros.slice(),
        },
        obv: zeros.slice(),
        engulfing: Array.from({ length: n }, () => null),
        htfEmaMid: zeros.slice(),
        htfRsi: zeros.slice(),
        htfAdx: { adx: zeros.slice(), pdi: zeros.slice(), mdi: zeros.slice() },
        last: {
            close: closes[lastIdx],
            rsi: 50,
            emaShort: emaShort[lastIdx],
            emaMid: emaMid[lastIdx],
            emaLong: emaMid[lastIdx],
            atr: 1,
            macdLine: 0,
            macdSignal: 0,
            macdHistogram: macdHist[lastIdx],
            bbUpper: bbUpper[lastIdx],
            bbMiddle: bbMiddle[lastIdx],
            bbLower: bbLower[lastIdx],
            bbBandwidth: 1,
            percentB: 0.5,
            stochasticK: 50,
            stochasticD: 50,
            momentum: 0,
            engulfing: null,
            vwma: 0,
            vwap: 0,
            obv: 0,
            htfEmaMid: 0,
            htfRsi: 50,
            htfAdx: 0,
            htfPdi: 0,
            htfMdi: 0,
        },
    } as IndicatorMap;
}

function ctx(
    classification: RegimeClassification,
    indicators: IndicatorMap,
    price?: number
): SetupContext {
    return {
        classification,
        indicators,
        price: price ?? indicators.last.close,
    };
}

test('TREND: valid bullish continuation setup + trigger → long', (t) => {
    const n = 6;
    const emaShort = Array(n).fill(100);
    const emaMid = Array(n).fill(98);
    const closes = [100.2, 99.8, 99.6, 99.7, 100.1, 100.5];
    const lows = [99.9, 99.5, 99.4, 99.5, 99.9, 100.2];
    const highs = closes.map((c) => c + 0.3);
    const macdHist = [-0.2, -0.3, -0.25, -0.1, 0.05, 0.2];
    const c = baseClassification({
        regime: 'TREND',
        isTrendEvidence: true,
        emaAlignedBullish: true,
        emaAlignedBearish: false,
        emaNeutral: false,
        trendBias: 'bullish',
        weakAdx: false,
        weakDiSeparation: false,
        isRangeEvidence: false,
        adx: 30,
        diDiff: 20,
    });
    const ind = buildIndicators({ n, closes, lows, highs, emaShort, emaMid, macdHist });
    const result = detectTrendSetup(ctx(c, ind));
    t.true(result.setupQualified);
    t.true(result.entryTriggered);
    t.true(result.detected);
    t.is(result.side, 'buy');
    t.is(result.setupId, 'trend_continuation_long');
    t.is(result.invalidation, null);
});

test('TREND: valid bearish continuation setup + trigger → short', (t) => {
    const n = 6;
    const emaShort = Array(n).fill(100);
    const emaMid = Array(n).fill(102);
    const closes = [100.1, 100.4, 100.5, 100.3, 99.9, 99.5];
    const highs = [100.5, 100.8, 100.9, 100.7, 100.2, 99.8];
    const lows = closes.map((c) => c - 0.3);
    const macdHist = [0.2, 0.15, 0.05, -0.05, -0.1, -0.25];
    const c = baseClassification({
        regime: 'TREND',
        isTrendEvidence: true,
        emaAlignedBullish: false,
        emaAlignedBearish: true,
        emaNeutral: false,
        trendBias: 'bearish',
        weakAdx: false,
        weakDiSeparation: false,
        isRangeEvidence: false,
        adx: 28,
        diDiff: 18,
    });
    const ind = buildIndicators({ n, closes, lows, highs, emaShort, emaMid, macdHist });
    const result = detectTrendSetup(ctx(c, ind));
    t.true(result.detected);
    t.is(result.side, 'sell');
    t.is(result.setupId, 'trend_continuation_short');
});

test('TREND: no pullback → no entry', (t) => {
    const n = 6;
    const emaShort = Array(n).fill(100);
    const emaMid = Array(n).fill(98);
    const closes = [103, 103.2, 103.5, 103.8, 104, 104.2];
    const lows = closes.map((c) => c - 0.1);
    const macdHist = [0.1, 0.15, 0.2, 0.25, 0.3, 0.35];
    const c = baseClassification({
        regime: 'TREND',
        isTrendEvidence: true,
        emaAlignedBullish: true,
        trendBias: 'bullish',
        emaNeutral: false,
    });
    const ind = buildIndicators({ n, closes, lows, emaShort, emaMid, macdHist });
    const result = detectTrendSetup(ctx(c, ind));
    t.false(result.detected);
    t.false(result.setupQualified);
    t.false(result.entryTriggered);
    t.is(result.side, null);
});

test('TREND: pullback without continuation trigger → no entry', (t) => {
    const n = 6;
    const emaShort = Array(n).fill(100);
    const emaMid = Array(n).fill(98);
    const closes = [100.2, 99.8, 99.6, 99.7, 99.5, 99.4];
    const lows = [99.9, 99.5, 99.4, 99.5, 99.3, 99.2];
    const macdHist = [-0.1, -0.2, -0.25, -0.3, -0.35, -0.4];
    const c = baseClassification({
        regime: 'TREND',
        isTrendEvidence: true,
        emaAlignedBullish: true,
        trendBias: 'bullish',
        emaNeutral: false,
    });
    const ind = buildIndicators({ n, closes, lows, emaShort, emaMid, macdHist });
    const result = detectTrendSetup(ctx(c, ind));
    t.true(result.setupQualified);
    t.false(result.entryTriggered);
    t.false(result.detected);
    t.is(result.side, null);
});

test('TREND: invalidated when price breaks emaMid → no entry', (t) => {
    const n = 6;
    const emaShort = Array(n).fill(100);
    const emaMid = Array(n).fill(98);
    const closes = [100, 99, 97, 96.5, 96, 95];
    const lows = closes.map((c) => c - 0.2);
    const macdHist = [0, -0.1, -0.2, -0.1, 0.05, 0.1];
    const c = baseClassification({
        regime: 'TREND',
        isTrendEvidence: true,
        emaAlignedBullish: true,
        trendBias: 'bullish',
        emaNeutral: false,
    });
    const ind = buildIndicators({ n, closes, lows, emaShort, emaMid, macdHist });
    const result = detectTrendSetup(ctx(c, ind, 95));
    t.false(result.detected);
    t.truthy(result.invalidation);
    t.true((result.invalidation as string).includes('emaMid'));
});

test('TREND: contradictory direction → no entry', (t) => {
    const c = baseClassification({
        regime: 'TREND',
        isTrendEvidence: true,
        emaAlignedBullish: true,
        trendBias: 'bearish',
        emaNeutral: false,
    });
    const result = detectTrendSetup(ctx(c, buildIndicators({})));
    t.false(result.detected);
    t.true(result.reasons.some((r) => /consistent direction|contradictory/i.test(r)));
});

test('TREND: regime alone is not an entry', (t) => {
    const c = baseClassification({
        regime: 'TREND',
        isTrendEvidence: true,
        emaAlignedBullish: true,
        trendBias: 'bullish',
        emaNeutral: false,
    });
    const ind = buildIndicators({
        closes: [110, 111, 112, 113, 114, 115],
        lows: [109.5, 110.5, 111.5, 112.5, 113.5, 114.5],
        emaShort: Array(6).fill(100),
        emaMid: Array(6).fill(98),
        macdHist: [1, 1.1, 1.2, 1.3, 1.4, 1.5],
    });
    const result = detectTrendSetup(ctx(c, ind));
    t.false(result.detected);
});

test('BREAKOUT: valid bullish structure + MACD confirmation → long', (t) => {
    const n = 4;
    const closes = [100, 101, 102, 106];
    const bbUpper = [104, 104.5, 105, 105.5];
    const bbLower = [96, 96, 96, 96];
    const bbMiddle = [100, 100, 100, 101];
    const macdHist = [0.1, 0.2, 0.5, 0.9];
    const c = baseClassification({
        regime: 'BREAKOUT',
        breakoutStructure: true,
        breakoutDirection: 'bullish',
        volumeConfirmed: true,
        isBreakout: true,
        isTrendEvidence: false,
        isRangeEvidence: false,
    });
    const ind = buildIndicators({ n, closes, bbUpper, bbLower, bbMiddle, macdHist });
    const result = detectBreakoutSetup(ctx(c, ind));
    t.true(result.setupQualified);
    t.true(result.entryTriggered);
    t.true(result.detected);
    t.is(result.side, 'buy');
    t.is(result.setupId, 'breakout_long');
});

test('BREAKOUT: valid bearish structure + MACD confirmation → short', (t) => {
    const n = 4;
    const closes = [100, 99, 98, 94];
    const bbUpper = [104, 104, 104, 104];
    const bbLower = [96, 95.5, 95, 94.5];
    const bbMiddle = [100, 100, 99, 98];
    const macdHist = [-0.1, -0.2, -0.4, -0.8];
    const c = baseClassification({
        regime: 'BREAKOUT',
        breakoutStructure: true,
        breakoutDirection: 'bearish',
        volumeConfirmed: true,
        isBreakout: true,
    });
    const ind = buildIndicators({ n, closes, bbUpper, bbLower, bbMiddle, macdHist });
    const result = detectBreakoutSetup(ctx(c, ind));
    t.true(result.detected);
    t.is(result.side, 'sell');
    t.is(result.setupId, 'breakout_short');
});

test('BREAKOUT: regime without MACD confirmation → no entry', (t) => {
    const n = 4;
    const closes = [100, 101, 102, 106];
    const bbUpper = [104, 104.5, 105, 105.5];
    const bbLower = [96, 96, 96, 96];
    const bbMiddle = [100, 100, 100, 101];
    const macdHist = [0.5, 0.4, 0.3, 0.2];
    const c = baseClassification({
        regime: 'BREAKOUT',
        breakoutStructure: true,
        breakoutDirection: 'bullish',
        volumeConfirmed: true,
        isBreakout: true,
    });
    const ind = buildIndicators({ n, closes, bbUpper, bbLower, bbMiddle, macdHist });
    const result = detectBreakoutSetup(ctx(c, ind));
    t.true(result.setupQualified);
    t.false(result.entryTriggered);
    t.false(result.detected);
    t.is(result.side, null);
});

test('BREAKOUT: failed break (close back through mid) → invalidated', (t) => {
    const n = 4;
    const closes = [100, 106, 103, 99];
    const bbUpper = [104, 104, 105, 105];
    const bbLower = [96, 96, 96, 96];
    const bbMiddle = [100, 100, 100, 100];
    const macdHist = [0.5, 0.8, 0.4, 0.1];
    const c = baseClassification({
        regime: 'BREAKOUT',
        breakoutStructure: true,
        breakoutDirection: 'bullish',
        volumeConfirmed: true,
        isBreakout: true,
    });
    const ind = buildIndicators({ n, closes, bbUpper, bbLower, bbMiddle, macdHist });
    const result = detectBreakoutSetup(ctx(c, ind));
    t.false(result.detected);
    t.truthy(result.invalidation);
});

test('BREAKOUT: missing direction → no entry', (t) => {
    const c = baseClassification({
        regime: 'BREAKOUT',
        breakoutStructure: true,
        breakoutDirection: null,
        volumeConfirmed: true,
        isBreakout: true,
    });
    const result = detectBreakoutSetup(ctx(c, buildIndicators({})));
    t.false(result.detected);
    t.is(result.side, null);
});

test('BREAKOUT: regime label alone is not an entry (no structure path)', (t) => {
    const c = baseClassification({
        regime: 'BREAKOUT',
        breakoutStructure: false,
        breakoutDirection: 'bullish',
        volumeConfirmed: true,
        isBreakout: false,
    });
    const result = detectBreakoutSetup(ctx(c, buildIndicators({})));
    t.false(result.detected);
    t.false(result.setupQualified);
});

test('RANGE: always NO_TRADE — no entries generated', (t) => {
    const c = baseClassification({ regime: 'RANGE', isRangeEvidence: true });
    const result = detectRangeSetup(ctx(c, buildIndicators({})));
    t.false(result.detected);
    t.false(result.setupQualified);
    t.false(result.entryTriggered);
    t.is(result.side, null);
    t.true(result.reasons.some((r) => /NO_TRADE/i.test(r)));
});

test('router: RANGE path never produces a side', (t) => {
    const c = baseClassification({ regime: 'RANGE' });
    const result = detectSetupForRegime(ctx(c, buildIndicators({})));
    t.is(result.side, null);
    t.false(result.detected);
});

test('determinism: identical context → identical setup result', (t) => {
    const c = baseClassification({
        regime: 'TREND',
        isTrendEvidence: true,
        emaAlignedBullish: true,
        trendBias: 'bullish',
        emaNeutral: false,
    });
    const ind = buildIndicators({
        closes: [100.2, 99.8, 99.6, 99.7, 100.1, 100.5],
        lows: [99.9, 99.5, 99.4, 99.5, 99.9, 100.2],
        emaShort: Array(6).fill(100),
        emaMid: Array(6).fill(98),
        macdHist: [-0.2, -0.3, -0.25, -0.1, 0.05, 0.2],
    });
    const a = detectTrendSetup(ctx(c, ind));
    const b = detectTrendSetup(ctx(c, ind));
    t.deepEqual(a, b);
});

test('setup uses only provided series length — no implicit future bars', (t) => {
    const c = baseClassification({
        regime: 'TREND',
        isTrendEvidence: true,
        emaAlignedBullish: true,
        trendBias: 'bullish',
        emaNeutral: false,
    });
    const ind = buildIndicators({ n: 3, emaShort: [100, 100, 100], emaMid: [98, 98, 98] });
    t.notThrows(() => detectTrendSetup(ctx(c, ind)));
});

// ---------------------------------------------------------------------------
// Temporal separation: pullback on PRIOR candles only
// ---------------------------------------------------------------------------

test('TREND: current-candle touch alone cannot manufacture pullback (bullish)', (t) => {
    const n = 6;
    const emaShort = Array(n).fill(100);
    const emaMid = Array(n).fill(98);
    const closes = [101.5, 101.8, 102.0, 101.9, 101.5, 100.5];
    const lows = [101.2, 101.4, 101.6, 101.5, 101.2, 99.8];
    const highs = closes.map((c) => c + 0.3);
    const macdHist = [0.1, 0.15, 0.2, 0.18, 0.1, 0.25];
    const c = baseClassification({
        regime: 'TREND',
        isTrendEvidence: true,
        emaAlignedBullish: true,
        trendBias: 'bullish',
        emaNeutral: false,
        weakAdx: false,
        weakDiSeparation: false,
        isRangeEvidence: false,
        adx: 30,
        diDiff: 20,
    });
    const ind = buildIndicators({ n, closes, lows, highs, emaShort, emaMid, macdHist });
    const result = detectTrendSetup(ctx(c, ind));
    t.false(result.setupQualified, 'decision candle must not qualify pullback');
    t.false(result.entryTriggered);
    t.false(result.detected);
    t.is(result.side, null);
});

test('TREND: current-candle touch alone cannot manufacture pullback (bearish)', (t) => {
    const n = 6;
    const emaShort = Array(n).fill(100);
    const emaMid = Array(n).fill(102);
    const closes = [98.5, 98.2, 98.0, 98.1, 98.5, 99.5];
    const highs = [98.8, 98.6, 98.4, 98.5, 98.8, 100.2];
    const lows = closes.map((c) => c - 0.3);
    const macdHist = [-0.1, -0.15, -0.2, -0.18, -0.1, -0.25];
    const c = baseClassification({
        regime: 'TREND',
        isTrendEvidence: true,
        emaAlignedBearish: true,
        trendBias: 'bearish',
        emaNeutral: false,
        weakAdx: false,
        weakDiSeparation: false,
        isRangeEvidence: false,
        adx: 28,
        diDiff: 18,
    });
    const ind = buildIndicators({ n, closes, lows, highs, emaShort, emaMid, macdHist });
    const result = detectTrendSetup(ctx(c, ind));
    t.false(result.setupQualified);
    t.false(result.entryTriggered);
    t.false(result.detected);
    t.is(result.side, null);
});

test('TREND: prior pullback + current trigger → long (temporal separation)', (t) => {
    const n = 6;
    const emaShort = Array(n).fill(100);
    const emaMid = Array(n).fill(98);
    const closes = [100.5, 100.2, 99.8, 99.9, 100.2, 100.6];
    const lows = [100.2, 99.9, 99.5, 99.7, 100.0, 100.3];
    const highs = closes.map((c) => c + 0.3);
    const macdHist = [-0.1, -0.15, -0.2, -0.1, 0.05, 0.2];
    const c = baseClassification({
        regime: 'TREND',
        isTrendEvidence: true,
        emaAlignedBullish: true,
        trendBias: 'bullish',
        emaNeutral: false,
        weakAdx: false,
        weakDiSeparation: false,
        isRangeEvidence: false,
        adx: 30,
        diDiff: 20,
    });
    const ind = buildIndicators({ n, closes, lows, highs, emaShort, emaMid, macdHist });
    const result = detectTrendSetup(ctx(c, ind));
    t.true(result.setupQualified);
    t.true(result.entryTriggered);
    t.true(result.detected);
    t.is(result.side, 'buy');
});

test('TREND: prior pullback + current trigger → short (temporal separation)', (t) => {
    const n = 6;
    const emaShort = Array(n).fill(100);
    const emaMid = Array(n).fill(102);
    const closes = [99.5, 99.8, 100.2, 100.1, 99.8, 99.4];
    const highs = [99.8, 100.1, 100.5, 100.3, 100.0, 99.7];
    const lows = closes.map((c) => c - 0.3);
    const macdHist = [0.1, 0.15, 0.2, 0.1, -0.05, -0.2];
    const c = baseClassification({
        regime: 'TREND',
        isTrendEvidence: true,
        emaAlignedBearish: true,
        trendBias: 'bearish',
        emaNeutral: false,
        weakAdx: false,
        weakDiSeparation: false,
        isRangeEvidence: false,
        adx: 28,
        diDiff: 18,
    });
    const ind = buildIndicators({ n, closes, lows, highs, emaShort, emaMid, macdHist });
    const result = detectTrendSetup(ctx(c, ind));
    t.true(result.setupQualified);
    t.true(result.entryTriggered);
    t.true(result.detected);
    t.is(result.side, 'sell');
});

test('TREND: prior pullback without current trigger → qualified but no entry', (t) => {
    const n = 6;
    const emaShort = Array(n).fill(100);
    const emaMid = Array(n).fill(98);
    const closes = [100.5, 100.2, 99.8, 99.9, 99.7, 99.5];
    const lows = [100.2, 99.9, 99.5, 99.6, 99.4, 99.3];
    const highs = closes.map((c) => c + 0.3);
    const macdHist = [-0.1, -0.15, -0.2, -0.25, -0.3, -0.35];
    const c = baseClassification({
        regime: 'TREND',
        isTrendEvidence: true,
        emaAlignedBullish: true,
        trendBias: 'bullish',
        emaNeutral: false,
    });
    const ind = buildIndicators({ n, closes, lows, highs, emaShort, emaMid, macdHist });
    const result = detectTrendSetup(ctx(c, ind));
    t.true(result.setupQualified);
    t.false(result.entryTriggered);
    t.false(result.detected);
    t.is(result.side, null);
});

test('TREND: pullback window never includes decision index', (t) => {
    const n = 5;
    const emaShort = Array(n).fill(100);
    const emaMid = Array(n).fill(98);
    const macdHist = [-0.2, -0.1, 0.0, 0.1, 0.3];
    const c = baseClassification({
        regime: 'TREND',
        isTrendEvidence: true,
        emaAlignedBullish: true,
        trendBias: 'bullish',
        emaNeutral: false,
    });
    const failInd = buildIndicators({
        n,
        closes: [101, 101.2, 101.5, 101.3, 100.5],
        lows: [100.8, 101.0, 101.2, 101.0, 99.9],
        emaShort,
        emaMid,
        macdHist,
    });
    const fail = detectTrendSetup(ctx(c, failInd));
    t.false(fail.setupQualified);
    const okInd = buildIndicators({
        n,
        closes: [101, 101.2, 101.5, 99.8, 100.5],
        lows: [100.8, 101.0, 101.2, 99.6, 100.2],
        emaShort,
        emaMid,
        macdHist,
    });
    const ok = detectTrendSetup(ctx(c, okInd));
    t.true(ok.setupQualified);
    t.true(ok.entryTriggered);
    t.true(ok.detected);
    t.is(ok.side, 'buy');
});
