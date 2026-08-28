// src/lib/baseline/report.ts
// Phase 0 — Assemble the full baseline report from normalized rows.
// Measurement only. No strategy changes.

import {
  auditDataQuality,
  buildEquityCurve,
  computePerformanceMetrics,
  confidenceBucket,
  DRAWDOWN_METHODOLOGY,
  groupBy,
  holdingTimeBucket,
} from './metrics';
import type { BaselineReport, BaselineReportMeta, BaselineTradeRow } from './types';

export interface BuildBaselineOptions {
  meta: Omit<
    BaselineReportMeta,
    'rowsExamined' | 'rowsIncluded' | 'rowsExcluded' | 'exclusionReasons'
  >;
  lowSampleThreshold?: number;
}

export function buildBaselineReport(
  allRows: BaselineTradeRow[],
  options: BuildBaselineOptions
): BaselineReport {
  const { audit, completedRows } = auditDataQuality(allRows);
  const threshold = options.lowSampleThreshold ?? 30;

  const overall = computePerformanceMetrics(completedRows);
  const buyRows = completedRows.filter((r) => r.side === 'buy');
  const sellRows = completedRows.filter((r) => r.side === 'sell');
  const takenRows = completedRows.filter((r) => r.wasTaken === true);

  const bySymbol = groupBy(completedRows, (r) => r.symbol || 'UNKNOWN', {
    lowSampleThreshold: threshold,
  });
  const byRegime = groupBy(
    completedRows,
    (r) => (r.regime && r.regime.length > 0 ? r.regime : 'unknown'),
    { lowSampleThreshold: threshold }
  );
  const byConfidenceBucket = groupBy(completedRows, (r) => confidenceBucket(r.confidence), {
    lowSampleThreshold: 10,
  });
  const byMlLabel = groupBy(
    completedRows,
    (r) => (r.label != null ? String(r.label) : 'null'),
    { lowSampleThreshold: 10 }
  );
  const byMlPredictedLabel = groupBy(
    completedRows.filter((r) => r.mlPredictedLabel != null),
    (r) => String(r.mlPredictedLabel),
    { lowSampleThreshold: 10 }
  );
  const byHoldingTime = groupBy(completedRows, (r) => holdingTimeBucket(r.durationMs), {
    lowSampleThreshold: 10,
  });

  const holdOrder = [
    '<5 min', '5-15 min', '15-30 min', '30-60 min',
    '1-2 h', '2-4 h', '4-8 h', '>=8 h', 'unknown',
  ];
  byHoldingTime.sort((a, b) => holdOrder.indexOf(a.key) - holdOrder.indexOf(b.key));

  const confOrder = ['0-20', '21-40', '41-60', '61-80', '81-100', 'unknown'];
  byConfidenceBucket.sort((a, b) => confOrder.indexOf(a.key) - confOrder.indexOf(b.key));

  const equityCurve = buildEquityCurve(completedRows);
  const buyMetrics = computePerformanceMetrics(buyRows);
  const sellMetrics = computePerformanceMetrics(sellRows);
  const takenMetrics = computePerformanceMetrics(takenRows);

  const observations: string[] = [];
  observations.push(
    `Dataset: ${overall.tradeCount} completed simulations ` +
      `(${overall.buyCount} BUY / ${overall.sellCount} SELL).`
  );
  if (buyMetrics.tradeCount > 0 && sellMetrics.tradeCount > 0) {
    const diff = buyMetrics.averageR - sellMetrics.averageR;
    observations.push(
      `Directional asymmetry: BUY avg R=${buyMetrics.averageR.toFixed(3)} (WR ${buyMetrics.winRate.toFixed(1)}%), ` +
        `SELL avg R=${sellMetrics.averageR.toFixed(3)} (WR ${sellMetrics.winRate.toFixed(1)}%). ` +
        `ΔR (BUY−SELL)=${diff.toFixed(3)}.`
    );
  }
  if (takenMetrics.tradeCount > 0) {
    observations.push(
      `Taken filter: ${takenMetrics.tradeCount}/${overall.tradeCount} ` +
        `(${((takenMetrics.tradeCount / Math.max(1, overall.tradeCount)) * 100).toFixed(1)}%) taken; ` +
        `taken avg R=${takenMetrics.averageR.toFixed(3)}, WR ${takenMetrics.winRate.toFixed(1)}%.`
    );
  }
  observations.push(
    'Phase 0 is measurement only. No strategy parameters were changed. ' +
      'These numbers are the immutable regression targets for later phases.'
  );

  const exclusionReasons = audit.issues
    .filter((i) => i.excluded)
    .map((i) => `${i.code}: ${i.count} — ${i.description}`);

  const round = (n: number, d: number) => {
    const f = 10 ** d;
    return Math.round(n * f) / f;
  };

  const baselineReference: Record<string, number | string | null> = {
    total_completed_trades: overall.tradeCount,
    buy_count: overall.buyCount,
    sell_count: overall.sellCount,
    win_rate_pct: round(overall.winRate, 2),
    average_R: round(overall.averageR, 4),
    median_R: round(overall.medianR, 4),
    profit_factor: overall.profitFactor != null ? round(overall.profitFactor, 4) : null,
    total_R: round(overall.totalR, 4),
    max_drawdown_R: round(overall.maxDrawdownR, 4),
    total_realized_pnl: round(overall.totalRealizedPnl, 6),
    avg_MFE_pct: round(overall.averageMFE, 4),
    avg_MAE_pct: round(overall.averageMAE, 4),
    mfe_mae_ratio: overall.mfeMaeRatio != null ? round(overall.mfeMaeRatio, 4) : null,
    buy_win_rate_pct: round(buyMetrics.winRate, 2),
    buy_avg_R: round(buyMetrics.averageR, 4),
    sell_win_rate_pct: round(sellMetrics.winRate, 2),
    sell_avg_R: round(sellMetrics.averageR, 4),
    taken_count: takenMetrics.tradeCount,
    taken_pct:
      overall.tradeCount > 0
        ? round((takenMetrics.tradeCount / overall.tradeCount) * 100, 2)
        : 0,
    taken_win_rate_pct: round(takenMetrics.winRate, 2),
    taken_avg_R: round(takenMetrics.averageR, 4),
    taken_profit_factor:
      takenMetrics.profitFactor != null ? round(takenMetrics.profitFactor, 4) : null,
    taken_total_R: round(takenMetrics.totalR, 4),
  };

  return {
    meta: {
      ...options.meta,
      rowsExamined: audit.rowsExamined,
      rowsIncluded: audit.rowsIncluded,
      rowsExcluded: audit.rowsExcluded,
      exclusionReasons,
    },
    dataQuality: audit,
    overall,
    buyVsSell: { buy: buyMetrics, sell: sellMetrics },
    bySymbol,
    byRegime,
    byConfidenceBucket,
    byMlLabel,
    byMlPredictedLabel,
    byHoldingTime,
    takenVsAll: {
      all: overall,
      taken: takenMetrics,
      totalCount: overall.tradeCount,
      takenCount: takenMetrics.tradeCount,
      percentageTaken:
        overall.tradeCount > 0
          ? (takenMetrics.tradeCount / overall.tradeCount) * 100
          : 0,
    },
    drawdownMethodology: DRAWDOWN_METHODOLOGY,
    equityCurve,
    observations,
    baselineReference,
  };
}

export function formatBaselineMarkdown(report: BaselineReport): string {
  const lines: string[] = [];
  const m = report.meta;
  const o = report.overall;
  const fmt = (n: number | null | undefined, d = 4) =>
    n == null || !Number.isFinite(n) ? 'n/a' : n.toFixed(d);
  const pct = (n: number) => `${n.toFixed(2)}%`;

  lines.push('# CRYPTO-SCANNER — PHASE 0 BASELINE REPORT');
  lines.push('');
  lines.push('## 1. Executive summary');
  lines.push('');
  lines.push(
    'This report freezes the **current strategy performance** before any strategy changes. ' +
      'It is generated from `simulated_trades` only. Strategy entry, scoring, exits, sizing, ' +
      'and ML filtering were **not modified**.'
  );
  lines.push('');
  for (const obs of report.observations) {
    lines.push(`- ${obs}`);
  }
  lines.push('');

  lines.push('## 2. Dataset / data-quality audit');
  lines.push('');
  lines.push('| Field | Value |');
  lines.push('|-------|-------|');
  lines.push(`| Repository | ${m.repository} |`);
  lines.push(`| Git commit SHA | \`${m.gitCommitSha}\` |`);
  lines.push(`| Report generated at | ${m.reportGeneratedAt} |`);
  lines.push(`| Data cutoff timestamp | ${m.dataCutoffTimestamp ?? 'none (full table)'} |`);
  lines.push(`| Dataset definition | ${m.datasetDefinition} |`);
  lines.push(`| Query methodology | ${m.queryMethodology} |`);
  lines.push(`| Rows examined | ${m.rowsExamined} |`);
  lines.push(`| Rows included (completed) | ${m.rowsIncluded} |`);
  lines.push(`| Rows excluded | ${m.rowsExcluded} |`);
  lines.push('');
  lines.push('**Integrity issues (not silently repaired)**');
  lines.push('');
  lines.push('| Code | Count | Excluded | Description |');
  lines.push('|------|------:|:--------:|-------------|');
  for (const issue of report.dataQuality.issues) {
    lines.push(
      `| ${issue.code} | ${issue.count} | ${issue.excluded ? 'yes' : 'no'} | ${issue.description} |`
    );
  }
  if (report.dataQuality.issues.length === 0) {
    lines.push('| (none) | 0 | — | No integrity issues detected |');
  }
  lines.push('');

  lines.push('## 3. Overall performance');
  lines.push('');
  lines.push(formatPerf(o, fmt, pct));
  lines.push('');

  lines.push('## 4. BUY vs SELL');
  lines.push('');
  lines.push('### BUY');
  lines.push(formatPerf(report.buyVsSell.buy, fmt, pct));
  lines.push('');
  lines.push('### SELL');
  lines.push(formatPerf(report.buyVsSell.sell, fmt, pct));
  lines.push('');

  lines.push('## 5. Symbol performance');
  lines.push('');
  lines.push(
    '| Symbol | n | BUY | SELL | WR% | Avg R | PF | Total R | Max DD R | Avg MFE | Avg MAE | Low-sample |'
  );
  lines.push(
    '|--------|--:|----:|-----:|----:|------:|---:|--------:|---------:|--------:|--------:|:----------:|'
  );
  for (const g of report.bySymbol) {
    lines.push(
      `| ${g.key} | ${g.tradeCount} | ${g.buyCount} | ${g.sellCount} | ${fmt(g.winRate, 1)} | ${fmt(g.averageR)} | ${fmt(g.profitFactor)} | ${fmt(g.totalR)} | ${fmt(g.maxDrawdownR)} | ${fmt(g.averageMFE)} | ${fmt(g.averageMAE)} | ${g.lowSample ? 'yes' : ''} |`
    );
  }
  lines.push('');

  lines.push('## 6. Regime performance');
  lines.push('');
  lines.push(
    '| Regime | n | BUY | SELL | WR% | Avg R | PF | Total R | Max DD R | Avg MFE | Avg MAE |'
  );
  lines.push(
    '|--------|--:|----:|-----:|----:|------:|---:|--------:|---------:|--------:|--------:|'
  );
  for (const g of report.byRegime) {
    lines.push(
      `| ${g.key} | ${g.tradeCount} | ${g.buyCount} | ${g.sellCount} | ${fmt(g.winRate, 1)} | ${fmt(g.averageR)} | ${fmt(g.profitFactor)} | ${fmt(g.totalR)} | ${fmt(g.maxDrawdownR)} | ${fmt(g.averageMFE)} | ${fmt(g.averageMAE)} |`
    );
  }
  lines.push('');

  lines.push('## 7. Confidence / score performance');
  lines.push('');
  lines.push('| Bucket | n | WR% | Avg R | PF | Total R |');
  lines.push('|--------|--:|----:|------:|---:|--------:|');
  for (const g of report.byConfidenceBucket) {
    lines.push(
      `| ${g.key} | ${g.tradeCount} | ${fmt(g.winRate, 1)} | ${fmt(g.averageR)} | ${fmt(g.profitFactor)} | ${fmt(g.totalR)} |`
    );
  }
  lines.push('');

  lines.push('## 8. ML-label performance');
  lines.push('');
  lines.push('### Recorded label');
  lines.push('| Label | n | WR% | Avg R | PF | Total R |');
  lines.push('|------:|--:|----:|------:|---:|--------:|');
  for (const g of report.byMlLabel) {
    lines.push(
      `| ${g.key} | ${g.tradeCount} | ${fmt(g.winRate, 1)} | ${fmt(g.averageR)} | ${fmt(g.profitFactor)} | ${fmt(g.totalR)} |`
    );
  }
  lines.push('');
  lines.push('### ML predicted label');
  if (report.byMlPredictedLabel.length === 0) {
    lines.push('_No ml_predicted_label values present._');
  } else {
    lines.push('| Predicted | n | WR% | Avg R | PF | Total R |');
    lines.push('|----------:|--:|----:|------:|---:|--------:|');
    for (const g of report.byMlPredictedLabel) {
      lines.push(
        `| ${g.key} | ${g.tradeCount} | ${fmt(g.winRate, 1)} | ${fmt(g.averageR)} | ${fmt(g.profitFactor)} | ${fmt(g.totalR)} |`
      );
    }
  }
  lines.push('');

  lines.push('## 9. Holding-time performance');
  lines.push('');
  lines.push('| Duration | n | WR% | Avg R | PF | Total R |');
  lines.push('|----------|--:|----:|------:|---:|--------:|');
  for (const g of report.byHoldingTime) {
    lines.push(
      `| ${g.key} | ${g.tradeCount} | ${fmt(g.winRate, 1)} | ${fmt(g.averageR)} | ${fmt(g.profitFactor)} | ${fmt(g.totalR)} |`
    );
  }
  lines.push('');

  lines.push('## 10. MFE / MAE analysis');
  lines.push('');
  lines.push('| Metric | Overall | BUY | SELL |');
  lines.push('|--------|--------:|----:|-----:|');
  lines.push(
    `| Avg MFE % | ${fmt(o.averageMFE)} | ${fmt(report.buyVsSell.buy.averageMFE)} | ${fmt(report.buyVsSell.sell.averageMFE)} |`
  );
  lines.push(
    `| Avg MAE % | ${fmt(o.averageMAE)} | ${fmt(report.buyVsSell.buy.averageMAE)} | ${fmt(report.buyVsSell.sell.averageMAE)} |`
  );
  lines.push(
    `| MFE/MAE ratio | ${fmt(o.mfeMaeRatio)} | ${fmt(report.buyVsSell.buy.mfeMaeRatio)} | ${fmt(report.buyVsSell.sell.mfeMaeRatio)} |`
  );
  lines.push('');

  lines.push('## 11. Taken vs all simulations');
  lines.push('');
  lines.push('| Population | n | WR% | Avg R | PF | Total R |');
  lines.push('|------------|--:|----:|------:|---:|--------:|');
  lines.push(
    `| All completed | ${report.takenVsAll.totalCount} | ${fmt(report.takenVsAll.all.winRate, 1)} | ${fmt(report.takenVsAll.all.averageR)} | ${fmt(report.takenVsAll.all.profitFactor)} | ${fmt(report.takenVsAll.all.totalR)} |`
  );
  lines.push(
    `| wasTaken = true | ${report.takenVsAll.takenCount} | ${fmt(report.takenVsAll.taken.winRate, 1)} | ${fmt(report.takenVsAll.taken.averageR)} | ${fmt(report.takenVsAll.taken.profitFactor)} | ${fmt(report.takenVsAll.taken.totalR)} |`
  );
  lines.push('');
  lines.push(`Percentage taken: **${pct(report.takenVsAll.percentageTaken)}**`);
  lines.push('');

  lines.push('## 12. Drawdown / equity analysis');
  lines.push('');
  lines.push(`- Ordering field: \`${report.drawdownMethodology.orderingField}\`);
  lines.push(`- Starting equity: ${report.drawdownMethodology.startingEquityR} R`);
  lines.push(`- Open trades excluded: ${report.drawdownMethodology.openTradesExcluded}`);
  lines.push(
    `- Simultaneous trades independent: ${report.drawdownMethodology.simultaneousTradesTreatedIndependently}`
  );
  lines.push(`- ${report.drawdownMethodology.description}`);
  lines.push('');
  lines.push(`Maximum drawdown: **${fmt(o.maxDrawdownR)} R**`);
  lines.push('');

  lines.push('## 13. Important observations');
  lines.push('');
  for (const obs of report.observations) {
    lines.push(`- ${obs}`);
  }
  lines.push('');

  lines.push('## 14. Baseline numbers (regression targets)');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(report.baselineReference, null, 2));
  lines.push('```');
  lines.push('');
  lines.push('---');
  lines.push('_Phase 0 complete when this report is reproducible against the same dataset._');

  return lines.join('\n');
}

function formatPerf(
  p: ReturnType<typeof computePerformanceMetrics>,
  fmt: (n: number | null | undefined, d?: number) => string,
  pct: (n: number) => string
): string {
  return [
    '| Metric | Value |',
    '|--------|------:|',
    `| Total completed | ${p.tradeCount} |`,
    `| BUY count | ${p.buyCount} |`,
    `| SELL count | ${p.sellCount} |`,
    `| Wins | ${p.winCount} |`,
    `| Losses | ${p.lossCount} |`,
    `| Win rate | ${pct(p.winRate)} |`,
    `| Average R | ${fmt(p.averageR)} |`,
    `| Median R | ${fmt(p.medianR)} |`,
    `| Gross profit R | ${fmt(p.grossProfitR)} |`,
    `| Gross loss R | ${fmt(p.grossLossR)} |`,
    `| Profit factor | ${fmt(p.profitFactor)} |`,
    `| Total R | ${fmt(p.totalR)} |`,
    `| Max drawdown R | ${fmt(p.maxDrawdownR)} |`,
    `| Total realized PnL | ${fmt(p.totalRealizedPnl, 6)} |`,
    `| Avg MFE % | ${fmt(p.averageMFE)} |`,
    `| Avg MAE % | ${fmt(p.averageMAE)} |`,
    `| MFE/MAE ratio | ${fmt(p.mfeMaeRatio)} |`,
  ].join('\n');
}
