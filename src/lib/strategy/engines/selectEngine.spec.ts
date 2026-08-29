// Phase 2B/3 — engine selection + isolation + routing tests

import test from 'ava';
import { resolveStrategyEngine, isRegimeEngine } from './selectEngine';
import { detectSetupForRegime } from './regime/setups';
import { applyQualityFilter } from './regime/quality';
import { detectTrendSetup } from './regime/setups/trendSetup';
import { detectRangeSetup } from './regime/setups/rangeSetup';
import { detectBreakoutSetup } from './regime/setups/breakoutSetup';
import type { RegimeClassification } from '../regime/types';
import type { SetupContext, SetupResult } from './types';
import type { IndicatorMap } from '../../utils/indicatorUtils';

function baseClassification(
    overrides: Partial<RegimeClassification>
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

function minimalIndicators(): IndicatorMap {
    const n = 6;
    const zeros = Array(n).fill(0);
    const closes = [100, 100.1, 100.2, 100.3, 100.4, 100.5];
    return {
        close: closes,
        high: closes.map((c) => c + 1),
        low: closes.map((c) => c - 1),
        open: closes.slice(),
        volume: Array(n).fill(1000),
        sma: zeros.slice(),
        emaShort: Array(n).fill(100),
        emaMid: Array(n).fill(99),
        emaLong: Array(n).fill(98),
        vwma: zeros.slice(),
        vwap: zeros.slice(),
        rsi: zeros.slice(),
        momentum: zeros.slice(),
        stochastic: { k: zeros.slice(), d: zeros.slice() },
        macd: { line: zeros.slice(), signal: zeros.slice(), histogram: zeros.slice() },
        atr: Array(n).fill(1),
        bollingerBands: {
            upper: Array(n).fill(105),
            middle: Array(n).fill(100),
            lower: Array(n).fill(95),
            bandwidth: zeros.slice(),
            percentB: zeros.slice(),
        },
        obv: zeros.slice(),
        engulfing: Array(n).fill(null),
        htfEmaMid: zeros.slice(),
        htfRsi: zeros.slice(),
        htfAdx: { adx: zeros.slice(), pdi: zeros.slice(), mdi: zeros.slice() },
        last: {
            close: closes[n - 1],
            rsi: 50,
            emaShort: 100,
            emaMid: 99,
            emaLong: 98,
            atr: 1,
            macdLine: 0,
            macdSignal: 0,
            macdHistogram: 0,
            bbUpper: 105,
            bbMiddle: 100,
            bbLower: 95,
            bbBandwidth: 1,
            percentB: 0.5,
            stochasticK: 50,
            stochasticD: 50,
            momentum: 0,
            engulfing: null,
            vwap: 0,
            vwma: 0,
            obv: 0,
            htfEmaMid: 0,
            htfRsi: 50,
            htfAdx: 0,
            htfPdi: 0,
            htfMdi: 0,
        },
    };
}

function ctx(c: RegimeClassification, ind?: IndicatorMap): SetupContext {
    const indicators = ind ?? minimalIndicators();
    return { classification: c, indicators, price: indicators.last.close };
}

test('engine selection: default / empty → legacy', (t) => {
    t.is(resolveStrategyEngine(undefined), 'legacy');
    t.is(resolveStrategyEngine(null), 'legacy');
    t.is(resolveStrategyEngine(''), 'legacy');
    t.is(resolveStrategyEngine('  '), 'legacy');
});

test('engine selection: explicit legacy and regime', (t) => {
    t.is(resolveStrategyEngine('legacy'), 'legacy');
    t.is(resolveStrategyEngine('LEGACY'), 'legacy');
    t.is(resolveStrategyEngine('regime'), 'regime');
    t.is(resolveStrategyEngine('Regime'), 'regime');
    t.true(isRegimeEngine('regime'));
    t.false(isRegimeEngine('legacy'));
});

test('engine selection: invalid value fails safely', (t) => {
    t.throws(() => resolveStrategyEngine('hybrid'), {
        message: /Invalid STRATEGY_ENGINE/,
    });
    t.throws(() => resolveStrategyEngine('foo'), {
        message: /Invalid STRATEGY_ENGINE/,
    });
});

test('isolation: regime engine does not import computeScores', (t) => {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const root = path.resolve(process.cwd(), 'src/lib/strategy/engines');
    const files = [
        'regime/engine.ts',
        'regime/quality.ts',
        'regime/setups/index.ts',
        'regime/setups/trendSetup.ts',
        'regime/setups/rangeSetup.ts',
        'regime/setups/breakoutSetup.ts',
        'dispatch.ts',
    ];
    for (const f of files) {
        const src = fs.readFileSync(path.join(root, f), 'utf8');
        t.false(
            /from ['"].*scoring\/computeScores['"]/.test(src),
            `${f} must not import computeScores`
        );
        t.false(
            /from ['"].*signal\/determineSignal['"]/.test(src),
            `${f} must not import determineSignal`
        );
        t.false(/\bcomputeScores\s*\(/.test(src), `${f} must not call computeScores`);
        t.false(/\bdetermineSignal\s*\(/.test(src), `${f} must not call determineSignal`);
    }
});

test('isolation: legacy scoring does not import regime engine', (t) => {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const scoring = fs.readFileSync(
        path.resolve(process.cwd(), 'src/lib/strategy/scoring/computeScores.ts'),
        'utf8'
    );
    t.false(scoring.includes('engines/regime'));
    t.false(scoring.includes('runRegimeEngine'));
    t.false(scoring.includes('detectSetupForRegime'));
});

test('routing: TREND selects trend setup subsystem', (t) => {
    const c = baseClassification({
        regime: 'TREND',
        isTrendEvidence: true,
        trendBias: 'bullish',
        emaAlignedBullish: true,
        emaNeutral: false,
        weakAdx: false,
        weakDiSeparation: false,
        isRangeEvidence: false,
        adx: 30,
        diDiff: 25,
    });
    const setup = detectSetupForRegime(ctx(c));
    t.true(
        setup.reasons.some((r) => /trend setup/i.test(r)) ||
            setup.setupId === 'trend_continuation_long' ||
            setup.setupId === 'trend_continuation_short' ||
            setup.setupId === null
    );
    t.false(setup.reasons.every((r) => /range setup/i.test(r)));
});

test('routing: RANGE selects range setup subsystem (NO_TRADE)', (t) => {
    const c = baseClassification({ regime: 'RANGE' });
    const setup = detectSetupForRegime(ctx(c));
    t.false(setup.detected);
    t.is(setup.side, null);
    t.true(setup.reasons.some((r) => /range setup/i.test(r)));
});

test('routing: BREAKOUT selects breakout setup subsystem', (t) => {
    const c = baseClassification({
        regime: 'BREAKOUT',
        isBreakout: true,
        breakoutStructure: true,
        volumeConfirmed: true,
        breakoutDirection: 'bearish',
        isTrendEvidence: false,
        isRangeEvidence: false,
    });
    const setup = detectSetupForRegime(ctx(c));
    t.true(setup.reasons.some((r) => /breakout setup/i.test(r)));
});

test('setup result is deterministic for identical classification context', (t) => {
    const c = baseClassification({
        regime: 'TREND',
        isTrendEvidence: true,
        trendBias: 'bearish',
        emaAlignedBearish: true,
        emaNeutral: false,
        adx: 28,
        diDiff: 20,
        weakAdx: false,
        weakDiSeparation: false,
        isRangeEvidence: false,
    });
    const context = ctx(c);
    const a = detectTrendSetup(context);
    const b = detectTrendSetup(context);
    t.deepEqual(a, b);
});

test('quality filter accepts detected setup with side', (t) => {
    const setup: SetupResult = {
        detected: true,
        setupId: 'trend_continuation_long',
        side: 'buy',
        setupQualified: true,
        entryTriggered: true,
        invalidation: null,
        reasons: ['ok'],
        diagnostics: {},
    };
    const q = applyQualityFilter(setup);
    t.true(q.accepted);
});

test('quality filter rejects undetected setup', (t) => {
    const setup = detectRangeSetup(ctx(baseClassification({ regime: 'RANGE' })));
    const q = applyQualityFilter(setup);
    t.false(q.accepted);
});

test('breakout setup rejects missing direction', (t) => {
    const c = baseClassification({
        regime: 'BREAKOUT',
        isBreakout: true,
        breakoutDirection: null,
        breakoutStructure: true,
    });
    const setup = detectBreakoutSetup(ctx(c));
    t.false(setup.detected);
});

test('regime engine does not hard-code confidence=50 or accountBalance=1000', (t) => {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const src = fs.readFileSync(
        path.resolve(process.cwd(), 'src/lib/strategy/engines/regime/engine.ts'),
        'utf8'
    );
    t.false(/,\s*50\s*,/.test(src), 'must not pass literal confidence 50');
    t.false(/,\s*1000\s*,/.test(src), 'must not pass literal accountBalance 1000');
    t.false(/confidence\s*=\s*50/.test(src), 'must not assign confidence = 50');
    t.true(
        src.includes('config.strategy.confidenceThreshold'),
        'must use configured confidenceThreshold'
    );
    t.true(
        src.includes('undefined'),
        'must omit accountBalance (undefined) rather than invent equity'
    );
});
