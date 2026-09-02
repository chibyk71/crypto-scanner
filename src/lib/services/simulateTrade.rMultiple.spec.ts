// P1.1 — R-multiple riskPct floor prevents extreme |R|

import test from 'ava';

import {
    computeRiskPctForR,
    MIN_RISK_PCT_FOR_R,
} from './simulateTrade';

test('computeRiskPctForR floors tight SL distance at MIN_RISK_PCT_FOR_R (0.1%)', (t) => {
    const entry = 100;
    const tightSl = entry * (1 - 0.00005);
    const riskPct = computeRiskPctForR(entry, tightSl);
    t.is(riskPct, MIN_RISK_PCT_FOR_R);
    t.true(riskPct >= 0.001);
});

test('computeRiskPctForR preserves realistic ATR-scale SL distance', (t) => {
    const entry = 100;
    const sl = entry * (1 - 0.015);
    const riskPct = computeRiskPctForR(entry, sl);
    t.true(Math.abs(riskPct - 0.015) < 1e-9);
});

test('computeRiskPctForR falls back when stopLoss missing', (t) => {
    t.is(computeRiskPctForR(100, undefined), 0.015);
    t.is(computeRiskPctForR(100, null), 0.015);
    t.is(computeRiskPctForR(100, 0), 0.015);
});

test('rMultiple stays within sane bounds for tight-but-floored SL', (t) => {
    const entry = 50_000;
    const tightSl = entry * (1 - 0.00005);
    const riskPct = computeRiskPctForR(entry, tightSl);
    const totalPnL = 0.005;
    const rMultiple = totalPnL / riskPct;
    t.true(Math.abs(rMultiple) <= 50);
    t.is(rMultiple, 5);
});
