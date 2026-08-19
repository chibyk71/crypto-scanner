// Unit tests for evaluateConditionTree — covers the 5 required cases.
import test from 'ava';
import type { IndicatorMap } from '../../../utils/indicatorUtils';
import {
    evaluateConditionTree,
} from './evaluateConditionTree';
import type { ConditionNode } from '../types';

/**
 * Minimal SeriesCache stand-in: returns a pre-seeded IndicatorMap per timeframe.
 * No network / exchange dependency.
 */
class FakeCache {
    constructor(private readonly maps: Record<string, IndicatorMap | null>) { }

    async get(timeframe: string): Promise<IndicatorMap | null> {
        return this.maps[timeframe] ?? null;
    }
}

/** Build a tiny IndicatorMap with only the series we need for tests */
function makeMap(partial: {
    close?: number[];
    rsi?: number[];
    emaMid?: number[];
}): IndicatorMap {
    const close = partial.close ?? [100, 101, 102];
    const zeros = close.map(() => 0);
    const emptyAdx = { adx: zeros, pdi: zeros, mdi: zeros };
    return {
        close,
        high: close,
        low: close,
        open: close,
        volume: zeros,
        sma: zeros,
        emaShort: zeros,
        emaMid: partial.emaMid ?? zeros,
        emaLong: zeros,
        vwma: zeros,
        vwap: zeros,
        rsi: partial.rsi ?? zeros,
        momentum: zeros,
        stochastic: { k: zeros, d: zeros },
        macd: { line: zeros, signal: zeros, histogram: zeros },
        atr: zeros,
        bollingerBands: {
            upper: zeros,
            middle: zeros,
            lower: zeros,
            bandwidth: zeros,
            percentB: zeros,
        },
        obv: zeros,
        engulfing: close.map(() => null),
        htfEmaMid: zeros,
        htfRsi: zeros,
        htfAdx: emptyAdx,
        last: {
            close: close.at(-1)!,
            rsi: (partial.rsi ?? zeros).at(-1)!,
            emaShort: 0,
            emaMid: (partial.emaMid ?? zeros).at(-1)!,
            emaLong: 0,
            atr: 0,
            macdLine: 0,
            macdSignal: 0,
            macdHistogram: 0,
            bbUpper: 0,
            bbMiddle: 0,
            bbLower: 0,
            bbBandwidth: 0,
            percentB: 0,
            stochasticK: 0,
            stochasticD: 0,
            momentum: 0,
            engulfing: null,
            vwap: 0,
            vwma: 0,
            obv: 0,
            htfEmaMid: 0,
            htfRsi: 0,
            htfAdx: 0,
            htfPdi: 0,
            htfMdi: 0,
        },
    };
}

// ---------------------------------------------------------------------------
// 1. Flat AND — mixed true/false → overall false
// ---------------------------------------------------------------------------
test('flat AND: mixed true/false → false', async (t) => {
    const cache = new FakeCache({
        '1h': makeMap({
            rsi: [40, 55], // current 55 > 50 → true for >
            close: [100, 99], // current 99 < 100 → false for >
        }),
    }) as any;

    const tree: ConditionNode = {
        op: 'AND',
        conditions: [
            {
                indicator: 'rsi',
                timeframe: '1h',
                operator: '>',
                target: 50,
            },
            {
                indicator: 'close',
                timeframe: '1h',
                operator: '>',
                target: 100,
            },
        ],
    };

    const result = await evaluateConditionTree(tree, cache);
    t.false(result.met);
    t.deepEqual(result.reasons, []);
});

// ---------------------------------------------------------------------------
// 2. Flat OR — one true → overall true
// ---------------------------------------------------------------------------
test('flat OR: one true → true', async (t) => {
    const cache = new FakeCache({
        '1h': makeMap({
            rsi: [40, 55],
            close: [100, 99],
        }),
    }) as any;

    const tree: ConditionNode = {
        op: 'OR',
        conditions: [
            {
                indicator: 'rsi',
                timeframe: '1h',
                operator: '>',
                target: 50,
            },
            {
                indicator: 'close',
                timeframe: '1h',
                operator: '>',
                target: 100,
            },
        ],
    };

    const result = await evaluateConditionTree(tree, cache);
    t.true(result.met);
    t.true(result.reasons.length >= 1);
});

// ---------------------------------------------------------------------------
// 3. Nested AND(OR(...), leaf)
// ---------------------------------------------------------------------------
test('nested AND(OR(...), leaf)', async (t) => {
    const cache = new FakeCache({
        '1h': makeMap({
            rsi: [40, 55],
            close: [100, 101],
        }),
        '15m': makeMap({
            close: [50, 51],
        }),
    }) as any;

    const tree: ConditionNode = {
        op: 'AND',
        conditions: [
            {
                op: 'OR',
                conditions: [
                    {
                        indicator: 'rsi',
                        timeframe: '1h',
                        operator: '<',
                        target: 30, // false
                    },
                    {
                        indicator: 'close',
                        timeframe: '1h',
                        operator: '>',
                        target: 100, // true
                    },
                ],
            },
            {
                indicator: 'close',
                timeframe: '15m',
                operator: '>',
                target: 50, // true
            },
        ],
    };

    const result = await evaluateConditionTree(tree, cache);
    t.true(result.met);
});

// ---------------------------------------------------------------------------
// 4. crosses_above with prev/current
// ---------------------------------------------------------------------------
test('crosses_above: previous <= target and current > target', async (t) => {
    // close was 99, now 101 — crosses above 100
    const cache = new FakeCache({
        '1h': makeMap({
            close: [98, 99, 101],
            emaMid: [100, 100, 100],
        }),
    }) as any;

    const tree: ConditionNode = {
        indicator: 'close',
        timeframe: '1h',
        operator: 'crosses_above',
        target: 100,
    };

    const result = await evaluateConditionTree(tree, cache);
    t.true(result.met);

    // Already above — should NOT cross
    const cache2 = new FakeCache({
        '1h': makeMap({
            close: [101, 102, 103],
        }),
    }) as any;
    const result2 = await evaluateConditionTree(tree, cache2);
    t.false(result2.met);

    // Crosses above another indicator series
    const treeInd: ConditionNode = {
        indicator: 'close',
        timeframe: '1h',
        operator: 'crosses_above',
        target: 'ema_50',
    };
    const cache3 = new FakeCache({
        '1h': makeMap({
            close: [99, 101], // prev 99, curr 101
            emaMid: [100, 100], // prev 100, curr 100
        }),
    }) as any;
    const result3 = await evaluateConditionTree(treeInd, cache3);
    t.true(result3.met);
});

// ---------------------------------------------------------------------------
// 5. Missing timeframe data → false without throwing
// ---------------------------------------------------------------------------
test('missing timeframe data → false without throwing', async (t) => {
    const cache = new FakeCache({
        // no '4h' entry
        '1h': makeMap({ close: [1, 2] }),
    }) as any;

    const tree: ConditionNode = {
        indicator: 'close',
        timeframe: '4h',
        operator: '>',
        target: 0,
    };

    const result = await evaluateConditionTree(tree, cache);
    t.false(result.met);
    t.deepEqual(result.reasons, []);
});
