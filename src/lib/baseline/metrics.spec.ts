// src/lib/baseline/metrics.spec.ts
// Phase 0 — Unit tests for pure baseline metrics (no DB, no strategy).

import test from 'ava';
import {
  auditDataQuality,
  buildEquityCurve,
  computeMaxDrawdownR,
  computePerformanceMetrics,
  confidenceBucket,
  groupBy,
  holdingTimeBucket,
} from './metrics';
import { normalizeExportRow } from './loadFromDb';
import type { BaselineTradeRow } from './types';

function row(partial: Partial<BaselineTradeRow> & { id: number }): BaselineTradeRow {
  return {
    signalId: `sig-${partial.id}`,
    symbol: 'BTC/USDT',
    side: 'buy',
    regime: 'strong_trend',
    confidence: 70,
    openedAt: 1_000_000,
    closedAt: 1_060_000,
    outcome: 'tp',
    rMultiple: 1.5,
    pnl: 10,
    label: 1,
    mfe: 2.0,
    mae: -0.8,
    durationMs: 60_000,
    timeToMFEMs: 30_000,
    timeToMAEMs: 10_000,
    wasTaken: false,
    mlPredictedLabel: 1,
    mlPredictedConfidence: 0.6,
    ...partial,
  };
}

test('computeMaxDrawdownR: simple peak-to-trough', (t) => {
  const dd = computeMaxDrawdownR([1, 1, -2, 0.5]);
  t.is(dd, -2);
});

test('computeMaxDrawdownR: empty and always-up', (t) => {
  t.is(computeMaxDrawdownR([]), 0);
  t.is(computeMaxDrawdownR([1, 1, 1]), 0);
});

test('computePerformanceMetrics: win rate and R aggregates', (t) => {
  const rows = [
    row({ id: 1, outcome: 'tp', rMultiple: 2, side: 'buy' }),
    row({ id: 2, outcome: 'sl', rMultiple: -1, side: 'sell' }),
    row({ id: 3, outcome: 'partial_tp', rMultiple: 1, side: 'buy' }),
    row({ id: 4, outcome: 'timeout', rMultiple: -0.2, side: 'sell' }),
  ];
  const m = computePerformanceMetrics(rows);
  t.is(m.tradeCount, 4);
  t.is(m.buyCount, 2);
  t.is(m.sellCount, 2);
  t.is(m.winCount, 2);
  t.is(m.winRate, 50);
  t.is(m.averageR, (2 - 1 + 1 - 0.2) / 4);
  t.is(m.grossProfitR, 3);
  t.is(m.grossLossR, -1.2);
  t.true(m.profitFactor != null && Math.abs(m.profitFactor! - 3 / 1.2) < 1e-9);
  t.is(m.totalR, 1.8);
});

test('buildEquityCurve: ordered by closedAt', (t) => {
  const rows = [
    row({ id: 2, closedAt: 200, rMultiple: -1 }),
    row({ id: 1, closedAt: 100, rMultiple: 2 }),
    row({ id: 3, closedAt: 300, rMultiple: 0.5 }),
  ];
  const curve = buildEquityCurve(rows);
  t.is(curve.length, 3);
  t.is(curve[0]!.cumulativeR, 2);
  t.is(curve[1]!.cumulativeR, 1);
  t.is(curve[2]!.cumulativeR, 1.5);
  t.is(curve[1]!.drawdownR, -1);
});

test('confidenceBucket ranges', (t) => {
  t.is(confidenceBucket(0), '0-20');
  t.is(confidenceBucket(20), '0-20');
  t.is(confidenceBucket(21), '21-40');
  t.is(confidenceBucket(60), '41-60');
  t.is(confidenceBucket(61), '61-80');
  t.is(confidenceBucket(100), '81-100');
  t.is(confidenceBucket(null), 'unknown');
});

test('holdingTimeBucket ranges', (t) => {
  t.is(holdingTimeBucket(2 * 60_000), '<5 min');
  t.is(holdingTimeBucket(10 * 60_000), '5-15 min');
  t.is(holdingTimeBucket(90 * 60_000), '1-2 h');
  t.is(holdingTimeBucket(9 * 60 * 60_000), '>=8 h');
});

test('groupBy marks low-sample', (t) => {
  const rows = Array.from({ length: 5 }, (_, i) =>
    row({ id: i + 1, symbol: 'ETH/USDT' })
  );
  const groups = groupBy(rows, (r) => r.symbol, { lowSampleThreshold: 30 });
  t.is(groups.length, 1);
  t.true(groups[0]!.lowSample);
});

test('auditDataQuality excludes open trades only', (t) => {
  const rows = [
    row({ id: 1, closedAt: 100, outcome: 'tp' }),
    row({ id: 2, closedAt: null, outcome: null }),
    row({ id: 3, closedAt: 200, outcome: 'sl', rMultiple: null }),
  ];
  const { audit, completedRows } = auditDataQuality(rows);
  t.is(audit.rowsExamined, 3);
  t.is(audit.rowsIncluded, 2);
  t.is(audit.rowsExcluded, 1);
  t.is(completedRows.length, 2);
  t.true(audit.issues.some((i) => i.code === 'open_or_missing_outcome' && i.excluded));
  t.true(audit.issues.some((i) => i.code === 'missing_r_multiple' && !i.excluded));
});

test('computePerformanceMetrics handles empty set', (t) => {
  const m = computePerformanceMetrics([]);
  t.is(m.tradeCount, 0);
  t.is(m.winRate, 0);
  t.is(m.averageR, 0);
  t.is(m.maxDrawdownR, 0);
});

// ── Null MFE/MAE regression (missing ≠ 0) ───────────────────────────────────

test('null MFE is audited as missing and does not contribute 0 to average', (t) => {
  const rows = [
    row({ id: 1, mfe: 2.0, mae: -1.0 }),
    row({ id: 2, mfe: null, mae: -1.0 }),
    row({ id: 3, mfe: 4.0, mae: -1.0 }),
  ];
  const { audit } = auditDataQuality(rows);
  t.true(audit.issues.some((i) => i.code === 'missing_mfe' && i.count === 1));
  t.true(audit.issues.some((i) => i.code === 'missing_mfe_mae' && i.count === 1));

  const m = computePerformanceMetrics(rows);
  // Average must be (2+4)/2 = 3, not (2+0+4)/3
  t.is(m.averageMFE, 3);
});

test('null MAE is audited as missing and does not contribute 0 to average', (t) => {
  const rows = [
    row({ id: 1, mfe: 2.0, mae: -2.0 }),
    row({ id: 2, mfe: 2.0, mae: null }),
    row({ id: 3, mfe: 2.0, mae: -4.0 }),
  ];
  const { audit } = auditDataQuality(rows);
  t.true(audit.issues.some((i) => i.code === 'missing_mae' && i.count === 1));

  const m = computePerformanceMetrics(rows);
  // Average MAE signed: (-2 + -4)/2 = -3, not (-2+0+-4)/3
  t.is(m.averageMAE, -3);
});

test('null MFE/MAE do not fabricate MFE/MAE ratio', (t) => {
  const withNulls = [
    row({ id: 1, mfe: null, mae: null }),
    row({ id: 2, mfe: 4.0, mae: -2.0 }),
  ];
  const m = computePerformanceMetrics(withNulls);
  t.is(m.averageMFE, 4);
  t.is(m.averageMAE, -2);
  t.is(m.mfeMaeRatio, 2);

  const allMissing = [
    row({ id: 1, mfe: null, mae: null }),
    row({ id: 2, mfe: null, mae: null }),
  ];
  const m2 = computePerformanceMetrics(allMissing);
  t.is(m2.averageMFE, 0);
  t.is(m2.averageMAE, 0);
  t.is(m2.mfeMaeRatio, null);
});

test('genuine MFE/MAE of zero remain valid zero measurements', (t) => {
  const rows = [
    row({ id: 1, mfe: 0, mae: 0 }),
    row({ id: 2, mfe: 2.0, mae: -1.0 }),
  ];
  const { audit } = auditDataQuality(rows);
  t.false(audit.issues.some((i) => i.code === 'missing_mfe'));
  t.false(audit.issues.some((i) => i.code === 'missing_mae'));

  const m = computePerformanceMetrics(rows);
  t.is(m.averageMFE, 1.0);
  t.is(m.averageMAE, -0.5);
});

test('complete rows baseline metrics unchanged with present MFE/MAE', (t) => {
  const rows = [
    row({ id: 1, outcome: 'tp', rMultiple: 2, mfe: 2.0, mae: -0.5 }),
    row({ id: 2, outcome: 'sl', rMultiple: -1, mfe: 0.3, mae: -1.2 }),
  ];
  const m = computePerformanceMetrics(rows);
  t.is(m.tradeCount, 2);
  t.is(m.winCount, 1);
  t.is(m.winRate, 50);
  t.is(m.averageR, 0.5);
  t.is(m.averageMFE, (2.0 + 0.3) / 2);
  t.is(m.averageMAE, (-0.5 + -1.2) / 2);
  t.true(m.mfeMaeRatio != null);
});

test('normalizeExportRow preserves null MFE/MAE (does not fabricate 0)', (t) => {
  const r = normalizeExportRow(
    {
      id: 1,
      signal_id: 's1',
      symbol: 'BTC/USDT',
      side: 'buy',
      opened_at: 1,
      closed_at: 2,
      outcome: 'tp',
      r_multiple: 15000,
      pnl: 0,
    },
    'storage'
  );
  t.is(r.mfe, null);
  t.is(r.mae, null);
  t.is(r.rMultiple, 1.5);
});

test('normalizeExportRow keeps genuine zero MFE/MAE as zero', (t) => {
  const r = normalizeExportRow(
    {
      id: 1,
      signal_id: 's1',
      symbol: 'BTC/USDT',
      side: 'buy',
      opened_at: 1,
      closed_at: 2,
      outcome: 'tp',
      mfe: 0,
      mae: 0,
      r_multiple: 0,
      pnl: 0,
    },
    'storage'
  );
  t.is(r.mfe, 0);
  t.is(r.mae, 0);
});
