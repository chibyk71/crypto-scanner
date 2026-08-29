// Phase 2B — engine selection + isolation tests

import test from 'ava';
import { resolveStrategyEngine, isRegimeEngine } from './selectEngine';
import { detectSetupForRegime } from './regime/setups';
import { applyQualityFilter } from './regime/quality';
import { detectTrendSetup } from './regime/setups/trendSetup';
import { detectRangeSetup } from './regime/setups/rangeSetup';
import { detectBreakoutSetup } from './regime/setups/breakoutSetup';
import type { RegimeClassification } from '../regime/types';
import type { SetupResult } from './types';

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
        t.false(
            /\bcomputeScores\s*\(/.test(src),
            `${f} must not call computeScores`
        );
        t.false(
            /\bdetermineSignal\s*\(/.test(src),
            `${f} must not call determineSignal`
        );
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
    const setup = detectSetupForRegime(c);
    t.is(setup.setupId, 'trend_continuation_long');
    t.is(setup.side, 'buy');
    t.true(setup.detected);
});

test('routing: RANGE selects range setup subsystem (no entry yet)', (t) => {
    const c = baseClassification({ regime: 'RANGE' });
    const setup = detectSetupForRegime(c);
    t.false(setup.detected);
    t.true(setup.reasons.some((r) => r.includes('range setup')));
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
    const setup = detectSetupForRegime(c);
    t.is(setup.setupId, 'breakout_short');
    t.is(setup.side, 'sell');
    t.true(setup.detected);
});

test('setup result is deterministic for identical classification', (t) => {
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
    const a = detectTrendSetup(c);
    const b = detectTrendSetup(c);
    t.deepEqual(a, b);
});

test('quality filter accepts detected setup with side', (t) => {
    const setup: SetupResult = {
        detected: true,
        setupId: 'trend_continuation_long',
        side: 'buy',
        reasons: ['ok'],
        diagnostics: {},
    };
    const q = applyQualityFilter(setup);
    t.true(q.accepted);
});

test('quality filter rejects undetected setup', (t) => {
    const setup = detectRangeSetup(baseClassification({ regime: 'RANGE' }));
    const q = applyQualityFilter(setup);
    t.false(q.accepted);
});

test('breakout setup rejects missing direction', (t) => {
    const c = baseClassification({
        regime: 'BREAKOUT',
        isBreakout: true,
        breakoutDirection: null,
    });
    const setup = detectBreakoutSetup(c);
    t.false(setup.detected);
});

test('regime engine does not hard-code confidence=50 or accountBalance=1000', (t) => {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const src = fs.readFileSync(
        path.resolve(process.cwd(), 'src/lib/strategy/engines/regime/engine.ts'),
        'utf8'
    );
    // Forbid literal experimental risk assumptions at the computeRiskParams call site.
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
