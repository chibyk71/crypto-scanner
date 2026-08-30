// src/lib/evaluation/evaluation.spec.ts
// Focused tests for the historical evaluation harness.
// Does not assert profitability.

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'mysql://user:pass@127.0.0.1:3306/eval_test';
}

import test from 'ava';
import {
  validateHistoricalCandles,
  candlesToOhlcvData,
  causalWindow,
  resolveTradeOffline,
  applySlippage,
  runHistoricalComparison,
  stableResultFingerprint,
  DEFAULT_EVALUATION_ASSUMPTIONS,
  type HistoricalCandle,
} from './index';
import { resolveStrategyEngine } from '../strategy/engines/selectEngine';

function candle(
  i: number,
  overrides: Partial<HistoricalCandle> = {}
): HistoricalCandle {
  const base = 100 + i * 0.1;
  return {
    symbol: 'TEST/USDT',
    timeframe: '3m',
    timestamp: 1_700_000_000_000 + i * 180_000,
    open: base,
    high: base + 0.5,
    low: base - 0.5,
    close: base + 0.1,
    volume: 1000,
    ...overrides,
  };
}

function series(n: number, start = 0): HistoricalCandle[] {
  return Array.from({ length: n }, (_, i) => candle(start + i));
}

test('candles are validated as chronological', (t) => {
  const ok = validateHistoricalCandles(series(5));
  t.true(ok.ok);
  t.is(ok.candles.length, 5);
});

test('duplicate timestamps are detected (not silently sorted)', (t) => {
  const bad = series(3);
  bad[2] = { ...bad[2]!, timestamp: bad[1]!.timestamp };
  const r = validateHistoricalCandles(bad);
  t.false(r.ok);
  t.true(r.issues.some((i) => i.code === 'DUPLICATE_TIMESTAMP'));
  t.is(r.candles.length, 0);
});

test('out-of-order timestamps are detected', (t) => {
  const bad = series(3);
  bad[2] = { ...bad[2]!, timestamp: bad[0]!.timestamp - 1 };
  const r = validateHistoricalCandles(bad);
  t.false(r.ok);
  t.true(r.issues.some((i) => i.code === 'OUT_OF_ORDER'));
});

test('invalid OHLCV is detected', (t) => {
  const bad = series(2);
  bad[1] = { ...bad[1]!, high: 1, low: 10, open: 5, close: 5 };
  const r = validateHistoricalCandles(bad);
  t.false(r.ok);
  t.true(r.issues.some((i) => i.code === 'INVALID_OHLCV'));
});

test('causalWindow never includes future candles', (t) => {
  const c = series(10);
  const win = causalWindow(c, 4);
  t.is(win.length, 5);
  t.is(win.timestamps[win.timestamps.length - 1], c[4]!.timestamp);
  t.true(win.timestamps.every((ts, i) => ts === c[i]!.timestamp));
});

test('candlesToOhlcvData preserves order and length', (t) => {
  const c = series(4);
  const d = candlesToOhlcvData(c);
  t.is(d.length, 4);
  t.deepEqual(d.closes, c.map((x) => x.close));
});

test('position lifecycle is deterministic (same input → same outcome)', (t) => {
  const candles = series(20);
  const signal = {
    symbol: 'TEST/USDT',
    signal: 'buy' as const,
    confidence: 60,
    reason: ['test'],
    features: [],
    stopLoss: candles[5]!.close * 0.99,
    takeProfit: candles[5]!.close * 1.5,
  };
  const a = resolveTradeOffline({
    engine: 'legacy',
    signal,
    decisionIndex: 5,
    candles,
    assumptions: DEFAULT_EVALUATION_ASSUMPTIONS,
  });
  const b = resolveTradeOffline({
    engine: 'legacy',
    signal,
    decisionIndex: 5,
    candles,
    assumptions: DEFAULT_EVALUATION_ASSUMPTIONS,
  });
  t.deepEqual(a, b);
  t.truthy(a.outcome);
});

test('fee calculations are identical for both engines', (t) => {
  const candles = series(15);
  const assumptions = {
    ...DEFAULT_EVALUATION_ASSUMPTIONS,
    feeRate: 0.001,
    slippageRate: 0,
    maxHoldBars: 5,
  };
  const mk = (engine: 'legacy' | 'regime') =>
    resolveTradeOffline({
      engine,
      signal: {
        symbol: 'TEST/USDT',
        signal: 'buy',
        confidence: 50,
        reason: [],
        features: [],
        stopLoss: candles[3]!.close * 0.98,
        takeProfit: candles[3]!.close * 1.02,
      },
      decisionIndex: 3,
      candles,
      assumptions,
    });
  const leg = mk('legacy');
  const reg = mk('regime');
  t.is(leg.fees, reg.fees);
  t.is(leg.entryPrice, reg.entryPrice);
  t.is(leg.pnl, reg.pnl);
  t.is(leg.outcome, reg.outcome);
});

test('incomplete trades when no bars after entry are explicit', (t) => {
  const candles = series(5);
  const trade = resolveTradeOffline({
    engine: 'legacy',
    signal: {
      symbol: 'TEST/USDT',
      signal: 'sell',
      confidence: 40,
      reason: [],
      features: [],
      stopLoss: candles[4]!.close * 1.02,
      takeProfit: candles[4]!.close * 0.98,
    },
    decisionIndex: 4,
    candles,
    assumptions: { ...DEFAULT_EVALUATION_ASSUMPTIONS, maxHoldBars: 10 },
  });
  t.true(trade.incomplete);
  t.is(trade.outcome, 'incomplete');
});

test('same-bar SL is used when TP not hit (deterministic priority)', (t) => {
  const candles = series(5);
  const entry = candles[2]!.close;
  candles[3] = {
    ...candles[3]!,
    high: entry + 0.01,
    low: entry * 0.97,
    close: entry * 0.98,
  };
  const trade = resolveTradeOffline({
    engine: 'legacy',
    signal: {
      symbol: 'TEST/USDT',
      signal: 'buy',
      confidence: 50,
      reason: [],
      features: [],
      stopLoss: entry * 0.99,
      takeProfit: entry * 1.1,
    },
    decisionIndex: 2,
    candles,
    assumptions: { ...DEFAULT_EVALUATION_ASSUMPTIONS, maxHoldBars: 3 },
  });
  t.is(trade.outcome, 'sl');
});

test('production default remains legacy engine', (t) => {
  t.is(resolveStrategyEngine(undefined), 'legacy');
  t.is(resolveStrategyEngine(null), 'legacy');
  t.is(resolveStrategyEngine(''), 'legacy');
});

test('LONG entry/exit adverse slippage worsens prices and P&L matches executed', (t) => {
  const rate = 0.001;
  const candles = series(8);
  const rawEntry = candles[2]!.close;
  const tp = rawEntry * 1.05;
  candles[3] = {
    ...candles[3]!,
    high: tp + 1,
    low: rawEntry * 0.99,
    close: tp,
  };
  const trade = resolveTradeOffline({
    engine: 'legacy',
    signal: {
      symbol: 'TEST/USDT',
      signal: 'buy',
      confidence: 50,
      reason: [],
      features: [],
      stopLoss: rawEntry * 0.95,
      takeProfit: tp,
    },
    decisionIndex: 2,
    candles,
    assumptions: {
      ...DEFAULT_EVALUATION_ASSUMPTIONS,
      slippageRate: rate,
      feeRate: 0,
      maxHoldBars: 5,
    },
  });
  const expectedEntry = rawEntry * (1 + rate);
  const expectedExit = tp * (1 - rate);
  t.is(trade.outcome, 'tp');
  t.true(Math.abs(trade.entryPrice - expectedEntry) < 1e-12);
  t.true(Math.abs((trade.exitPrice ?? 0) - expectedExit) < 1e-12);
  t.true(trade.entryPrice > rawEntry);
  t.true((trade.exitPrice ?? 0) < tp);
  const expectedPnl = (expectedExit - expectedEntry) / expectedEntry;
  t.true(Math.abs(trade.pnl - expectedPnl) < 1e-12);
  t.true(trade.rMultiple != null);
  const riskPct = Math.abs(expectedEntry - rawEntry * 0.95) / expectedEntry;
  t.true(Math.abs(trade.rMultiple! - expectedPnl / riskPct) < 1e-10);
});

test('SHORT entry/exit adverse slippage worsens prices and P&L matches executed', (t) => {
  const rate = 0.001;
  const candles = series(8);
  const rawEntry = candles[2]!.close;
  const tp = rawEntry * 0.95;
  candles[3] = {
    ...candles[3]!,
    high: rawEntry * 1.01,
    low: tp - 1,
    close: tp,
  };
  const trade = resolveTradeOffline({
    engine: 'legacy',
    signal: {
      symbol: 'TEST/USDT',
      signal: 'sell',
      confidence: 50,
      reason: [],
      features: [],
      stopLoss: rawEntry * 1.05,
      takeProfit: tp,
    },
    decisionIndex: 2,
    candles,
    assumptions: {
      ...DEFAULT_EVALUATION_ASSUMPTIONS,
      slippageRate: rate,
      feeRate: 0,
      maxHoldBars: 5,
    },
  });
  const expectedEntry = rawEntry * (1 - rate);
  const expectedExit = tp * (1 + rate);
  t.is(trade.outcome, 'tp');
  t.true(Math.abs(trade.entryPrice - expectedEntry) < 1e-12);
  t.true(Math.abs((trade.exitPrice ?? 0) - expectedExit) < 1e-12);
  t.true(trade.entryPrice < rawEntry);
  t.true((trade.exitPrice ?? 0) > tp);
  const expectedPnl = (expectedEntry - expectedExit) / expectedEntry;
  t.true(Math.abs(trade.pnl - expectedPnl) < 1e-12);
});

test('zero slippage leaves prices equal to raw targets', (t) => {
  const candles = series(8);
  const rawEntry = candles[2]!.close;
  const tp = rawEntry * 1.05;
  candles[3] = {
    ...candles[3]!,
    high: tp + 1,
    low: rawEntry * 0.99,
    close: tp,
  };
  const trade = resolveTradeOffline({
    engine: 'legacy',
    signal: {
      symbol: 'TEST/USDT',
      signal: 'buy',
      confidence: 50,
      reason: [],
      features: [],
      stopLoss: rawEntry * 0.95,
      takeProfit: tp,
    },
    decisionIndex: 2,
    candles,
    assumptions: {
      ...DEFAULT_EVALUATION_ASSUMPTIONS,
      slippageRate: 0,
      feeRate: 0,
      maxHoldBars: 5,
    },
  });
  t.is(trade.entryPrice, rawEntry);
  t.is(trade.exitPrice, tp);
  t.is(trade.pnl, (tp - rawEntry) / rawEntry);
});

test('applySlippage helper is adverse for all four combinations', (t) => {
  const p = 100;
  const r = 0.01;
  t.is(applySlippage(p, true, true, r), 101);
  t.is(applySlippage(p, true, false, r), 99);
  t.is(applySlippage(p, false, true, r), 99);
  t.is(applySlippage(p, false, false, r), 101);
  t.is(applySlippage(p, true, true, 0), 100);
});

test('comparison smoke: both engines run on same stream without throwing', async (t) => {
  const candles = series(80);
  const result = await runHistoricalComparison({
    candles,
    assumptions: {
      minPrimaryBars: 30,
      minHtfBars: 5,
      maxHoldBars: 5,
    },
    manifestLabel: 'smoke-test',
  });
  t.is(result.legacy.engine, 'legacy');
  t.is(result.regime.engine, 'regime');
  t.true(result.legacy.decisionsAttempted > 0);
  t.true(result.regime.decisionsAttempted > 0);
  t.is(result.legacy.warmUpSkipped, result.regime.warmUpSkipped);
  t.true(result.disclaimer.includes('does not establish'));
});

test('deterministic replay: same dataset twice → identical fingerprint', async (t) => {
  const candles = series(60);
  const opts = {
    candles,
    assumptions: {
      minPrimaryBars: 25,
      minHtfBars: 5,
      maxHoldBars: 4,
    },
    manifestLabel: 'replay',
  };
  const a = await runHistoricalComparison(opts);
  const b = await runHistoricalComparison(opts);
  t.is(stableResultFingerprint(a), stableResultFingerprint(b));
});

test('causal protection: future price shock does not change earlier decision window', (t) => {
  const base = series(40);
  const shocked = series(40);
  for (let i = 25; i < 40; i++) {
    shocked[i] = {
      ...shocked[i]!,
      open: 999,
      high: 1000,
      low: 998,
      close: 999,
    };
  }
  const winBase = causalWindow(base, 20);
  const winShock = causalWindow(shocked, 20);
  t.deepEqual(winBase.closes, winShock.closes);
  t.deepEqual(winBase.highs, winShock.highs);
});

test('warm-up skips decisions until minPrimaryBars', async (t) => {
  const candles = series(50);
  const result = await runHistoricalComparison({
    candles,
    assumptions: {
      minPrimaryBars: 40,
      minHtfBars: 3,
      maxHoldBars: 3,
    },
  });
  t.true(result.legacy.warmUpSkipped >= 39);
  t.is(result.legacy.warmUpSkipped, result.regime.warmUpSkipped);
});
