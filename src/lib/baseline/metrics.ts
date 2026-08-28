// src/lib/baseline/metrics.ts
// Phase 0 — Pure metric functions for baseline reporting.
// No strategy logic. Deterministic. Unit-testable.

import type {
  BaselineTradeRow,
  DataQualityAudit,
  DataQualityIssue,
  DrawdownMethodology,
  GroupMetrics,
  PerformanceMetrics,
} from './types';

/** Win outcomes used by existing analytics (tp / partial_tp). */
const WIN_OUTCOMES = new Set(['tp', 'partial_tp']);

export const DRAWDOWN_METHODOLOGY: DrawdownMethodology = {
  orderingField: 'closedAt',
  startingEquityR: 0,
  openTradesExcluded: true,
  simultaneousTradesTreatedIndependently: true,
  description:
    'Maximum drawdown is the maximum peak-to-trough decline of the cumulative ' +
    'realized R equity curve. Trades are ordered by closedAt ascending. ' +
    'Starting equity is 0 R. Only closed simulations with a finite rMultiple ' +
    'are included. Simultaneous closes are treated as independent sequential ' +
    'adds to equity in closedAt order (stable by id if timestamps equal). ' +
    'Open trades are excluded. Drawdown is reported in R units (negative or zero).',
};

export function isWin(row: BaselineTradeRow): boolean {
  return row.outcome != null && WIN_OUTCOMES.has(row.outcome);
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
  return sorted[mid]!;
}

function safeAvg(sum: number, n: number): number {
  return n > 0 ? sum / n : 0;
}

export function computeMaxDrawdownR(rSequence: number[]): number {
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  for (const r of rSequence) {
    equity += r;
    if (equity > peak) peak = equity;
    const dd = equity - peak;
    if (dd < maxDd) maxDd = dd;
  }
  return maxDd;
}

export function buildEquityCurve(
  rows: BaselineTradeRow[]
): Array<{ closedAt: number; cumulativeR: number; drawdownR: number }> {
  const sorted = [...rows]
    .filter((r) => r.closedAt != null && r.rMultiple != null && Number.isFinite(r.rMultiple))
    .sort((a, b) => {
      const t = (a.closedAt ?? 0) - (b.closedAt ?? 0);
      return t !== 0 ? t : a.id - b.id;
    });

  let equity = 0;
  let peak = 0;
  const curve: Array<{ closedAt: number; cumulativeR: number; drawdownR: number }> = [];

  for (const row of sorted) {
    equity += row.rMultiple!;
    if (equity > peak) peak = equity;
    const dd = equity - peak;
    curve.push({
      closedAt: row.closedAt!,
      cumulativeR: equity,
      drawdownR: dd,
    });
  }
  return curve;
}

export function computePerformanceMetrics(rows: BaselineTradeRow[]): PerformanceMetrics {
  const withR = rows.filter((r) => r.rMultiple != null && Number.isFinite(r.rMultiple));
  const rValues = withR.map((r) => r.rMultiple!);
  const sortedR = [...rValues].sort((a, b) => a - b);

  const wins = rows.filter(isWin);
  const losses = rows.filter((r) => !isWin(r) && r.outcome != null);

  let grossProfitR = 0;
  let grossLossR = 0;
  for (const r of rValues) {
    if (r > 0) grossProfitR += r;
    else if (r < 0) grossLossR += r;
  }

  const profitFactor =
    grossLossR < 0 ? grossProfitR / Math.abs(grossLossR) : null;

  // Exclude null/missing MFE/MAE from aggregates — missing ≠ 0
  const mfeValues = rows
    .map((r) => r.mfe)
    .filter((v): v is number => v != null && Number.isFinite(v));
  const maeValues = rows
    .map((r) => r.mae)
    .filter((v): v is number => v != null && Number.isFinite(v));
  const sortedMfe = [...mfeValues].sort((a, b) => a - b);
  const sortedMae = [...maeValues].sort((a, b) => a - b);

  const avgMfe = safeAvg(mfeValues.reduce((s, v) => s + v, 0), mfeValues.length);
  const avgMaeAbs = safeAvg(
    maeValues.reduce((s, v) => s + Math.abs(v), 0),
    maeValues.length
  );
  const mfeMaeRatio = avgMaeAbs > 0 ? avgMfe / avgMaeAbs : null;

  const timeToMfe = rows.map((r) => r.timeToMFEMs).filter((v) => v > 0 && Number.isFinite(v));
  const timeToMae = rows.map((r) => r.timeToMAEMs).filter((v) => v > 0 && Number.isFinite(v));

  const rSequence = withR
    .slice()
    .sort((a, b) => {
      const t = (a.closedAt ?? 0) - (b.closedAt ?? 0);
      return t !== 0 ? t : a.id - b.id;
    })
    .map((r) => r.rMultiple!);

  return {
    tradeCount: rows.length,
    buyCount: rows.filter((r) => r.side === 'buy').length,
    sellCount: rows.filter((r) => r.side === 'sell').length,
    winCount: wins.length,
    lossCount: losses.length,
    winRate: rows.length > 0 ? (wins.length / rows.length) * 100 : 0,
    averageR: safeAvg(rValues.reduce((s, v) => s + v, 0), rValues.length),
    medianR: median(sortedR),
    grossProfitR,
    grossLossR,
    profitFactor,
    totalR: rValues.reduce((s, v) => s + v, 0),
    totalRealizedPnl: rows.reduce((s, r) => s + (Number.isFinite(r.pnl) ? r.pnl : 0), 0),
    averageMFE: avgMfe,
    medianMFE: median(sortedMfe),
    averageMAE: safeAvg(maeValues.reduce((s, v) => s + v, 0), maeValues.length),
    medianMAE: median(sortedMae),
    mfeMaeRatio,
    averageTimeToMFEMs: safeAvg(timeToMfe.reduce((s, v) => s + v, 0), timeToMfe.length),
    averageTimeToMAEMs: safeAvg(timeToMae.reduce((s, v) => s + v, 0), timeToMae.length),
    maxDrawdownR: computeMaxDrawdownR(rSequence),
  };
}

export function groupBy(
  rows: BaselineTradeRow[],
  keyFn: (r: BaselineTradeRow) => string,
  options?: { lowSampleThreshold?: number }
): GroupMetrics[] {
  const map = new Map<string, BaselineTradeRow[]>();
  for (const row of rows) {
    const key = keyFn(row);
    const list = map.get(key) ?? [];
    list.push(row);
    map.set(key, list);
  }
  const threshold = options?.lowSampleThreshold ?? 30;
  const groups: GroupMetrics[] = [];
  for (const [key, groupRows] of map) {
    const metrics = computePerformanceMetrics(groupRows);
    groups.push({
      key,
      ...metrics,
      lowSample: groupRows.length < threshold,
    });
  }
  groups.sort((a, b) => b.tradeCount - a.tradeCount);
  return groups;
}

export function confidenceBucket(confidence: number | null): string {
  if (confidence == null || !Number.isFinite(confidence)) return 'unknown';
  const c = Math.max(0, Math.min(100, confidence));
  if (c <= 20) return '0-20';
  if (c <= 40) return '21-40';
  if (c <= 60) return '41-60';
  if (c <= 80) return '61-80';
  return '81-100';
}

export function holdingTimeBucket(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return 'unknown';
  const min = durationMs / 60_000;
  if (min < 5) return '<5 min';
  if (min < 15) return '5-15 min';
  if (min < 30) return '15-30 min';
  if (min < 60) return '30-60 min';
  if (min < 120) return '1-2 h';
  if (min < 240) return '2-4 h';
  if (min < 480) return '4-8 h';
  return '>=8 h';
}

export function auditDataQuality(allRows: BaselineTradeRow[]): {
  audit: DataQualityAudit;
  completedRows: BaselineTradeRow[];
} {
  const issues: DataQualityIssue[] = [];
  const n = allRows.length;

  const open = allRows.filter((r) => r.closedAt == null || r.outcome == null);
  if (open.length > 0) {
    issues.push({
      code: 'open_or_missing_outcome',
      count: open.length,
      description: 'Simulations still open or missing outcome (excluded from completed metrics)',
      excluded: true,
    });
  }

  const completed = allRows.filter((r) => r.closedAt != null && r.outcome != null);

  const missingR = completed.filter((r) => r.rMultiple == null || !Number.isFinite(r.rMultiple));
  if (missingR.length > 0) {
    issues.push({
      code: 'missing_r_multiple',
      count: missingR.length,
      description: 'Completed simulations with missing/non-finite R (excluded from R aggregates only)',
      excluded: false,
    });
  }

  // null or non-finite MFE/MAE are missing measurements — never treated as 0
  const missingMfe = completed.filter((r) => r.mfe == null || !Number.isFinite(r.mfe));
  const missingMae = completed.filter((r) => r.mae == null || !Number.isFinite(r.mae));
  const missingMfeMae = completed.filter(
    (r) => r.mfe == null || !Number.isFinite(r.mfe) || r.mae == null || !Number.isFinite(r.mae)
  );
  if (missingMfe.length > 0) {
    issues.push({
      code: 'missing_mfe',
      count: missingMfe.length,
      description: 'Completed simulations with null/non-finite MFE (excluded from MFE aggregates only)',
      excluded: false,
    });
  }
  if (missingMae.length > 0) {
    issues.push({
      code: 'missing_mae',
      count: missingMae.length,
      description: 'Completed simulations with null/non-finite MAE (excluded from MAE aggregates only)',
      excluded: false,
    });
  }
  if (missingMfeMae.length > 0) {
    issues.push({
      code: 'missing_mfe_mae',
      count: missingMfeMae.length,
      description: 'Completed simulations with missing MFE and/or MAE (not fabricated as zero)',
      excluded: false,
    });
  }

  const missingRegime = completed.filter((r) => r.regime == null || r.regime === '');
  if (missingRegime.length > 0) {
    issues.push({
      code: 'missing_regime',
      count: missingRegime.length,
      description: 'Completed simulations with null/empty regime',
      excluded: false,
    });
  }

  const missingConfidence = completed.filter(
    (r) => r.confidence == null || !Number.isFinite(r.confidence)
  );
  if (missingConfidence.length > 0) {
    issues.push({
      code: 'missing_confidence',
      count: missingConfidence.length,
      description: 'Completed simulations with missing confidence',
      excluded: false,
    });
  }

  const missingLabel = completed.filter((r) => r.label == null);
  if (missingLabel.length > 0) {
    issues.push({
      code: 'missing_ml_label',
      count: missingLabel.length,
      description: 'Completed simulations with null ML label',
      excluded: false,
    });
  }

  const signalIds = allRows.map((r) => r.signalId);
  const seen = new Set<string>();
  let dupes = 0;
  for (const id of signalIds) {
    if (seen.has(id)) dupes++;
    else seen.add(id);
  }
  if (dupes > 0) {
    issues.push({
      code: 'duplicate_signal_ids',
      count: dupes,
      description: 'Duplicate signal_id values (schema has unique constraint; report if present)',
      excluded: false,
    });
  }

  const impossibleDuration = completed.filter(
    (r) => r.durationMs < 0 || (r.closedAt != null && r.openedAt > r.closedAt)
  );
  if (impossibleDuration.length > 0) {
    issues.push({
      code: 'impossible_duration',
      count: impossibleDuration.length,
      description: 'Negative duration or closedAt < openedAt',
      excluded: false,
    });
  }

  const impossibleR = completed.filter(
    (r) => r.rMultiple != null && Number.isFinite(r.rMultiple) && Math.abs(r.rMultiple) > 50
  );
  if (impossibleR.length > 0) {
    issues.push({
      code: 'extreme_r_values',
      count: impossibleR.length,
      description: '|R| > 50 (flagged for review, not auto-excluded)',
      excluded: false,
    });
  }

  const malformedSymbol = allRows.filter(
    (r) => !r.symbol || !r.symbol.includes('/') || r.symbol.length > 50
  );
  if (malformedSymbol.length > 0) {
    issues.push({
      code: 'malformed_symbol',
      count: malformedSymbol.length,
      description: 'Symbol missing, no slash, or overly long',
      excluded: false,
    });
  }

  return {
    audit: {
      rowsExamined: n,
      rowsIncluded: completed.length,
      rowsExcluded: open.length,
      issues,
      openSimulations: open.length,
      duplicateSignalIds: dupes,
    },
    completedRows: completed,
  };
}
