// P0.1 — regime engine always populates signal.features (length 33)

import test from 'ava';
import type { StrategyInput } from '../../types';
import type { OhlcvData } from '../../../../types';
import type { MLService } from '../../../services/mlService';
import { runRegimeEngine } from './engine';

function makeOhlcv(n = 50, startPrice = 100): OhlcvData {
    const closes: number[] = [];
    const opens: number[] = [];
    const highs: number[] = [];
    const lows: number[] = [];
    const volumes: number[] = [];
    const timestamps: number[] = [];
    let p = startPrice;
    for (let i = 0; i < n; i++) {
        const o = p;
        const c = p * (1 + (i % 5 === 0 ? -0.002 : 0.001));
        closes.push(c);
        opens.push(o);
        highs.push(Math.max(o, c) * 1.002);
        lows.push(Math.min(o, c) * 0.998);
        volumes.push(1000 + i * 10);
        timestamps.push(1_700_000_000_000 + i * 180_000);
        p = c;
    }
    return { opens, highs, lows, closes, volumes, timestamps };
}

function makeInput(overrides: Partial<StrategyInput> = {}): StrategyInput {
    return {
        symbol: 'BTC/USDT',
        primaryData: makeOhlcv(80),
        htfData: makeOhlcv(80, 100),
        price: 100.5,
        atrMultiplier: 1.5,
        riskRewardTarget: 3,
        trailingStopPercent: 0.6,
        requireAtrFeasibility: false,
        ...overrides,
    };
}

function mockMlService(featureLen = 33): MLService {
    return {
        extractFeatures: async () => new Array(featureLen).fill(0),
        isReady: () => false,
        isDirectionalReady: () => false,
        predict: async () => ({ label: 0, confidence: 0 }),
        predictDirectional: async () => ({ label: 0, confidence: 0 }),
    } as unknown as MLService;
}

test('runRegimeEngine HOLD path still returns features.length === 33', async (t) => {
    const input = makeInput();
    const ml = mockMlService(33);
    const result = await runRegimeEngine(input, ml);

    t.is(result.engine, 'regime');
    t.true(Array.isArray(result.signal.features));
    t.is(result.signal.features.length, 33);
    t.is(result.signal.engine, 'regime');
});

test('runRegimeEngine features are present on every code path', async (t) => {
    const input = makeInput({ price: 100.5 });
    const ml = mockMlService(33);
    const result = await runRegimeEngine(input, ml);

    t.is(result.signal.features.length, 33);
    t.true(result.signal.features.length > 0);
});
