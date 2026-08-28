// src/lib/baseline/types.ts
// Phase 0 — Baseline measurement types only. No strategy logic.

/**
 * Normalized simulation row used for baseline metrics.
 * All monetary / percentage / R values are already converted to human units
 * (not ×1e8 / ×1e4 storage units).
 */
export interface BaselineTradeRow {
  id: number;
  signalId: string;
  symbol: string;
  side: 'buy' | 'sell';
  regime: string | null;
  confidence: number | null;
  openedAt: number;
  closedAt: number | null;
  outcome: string | null;
  /** Realized R-multiple (human units) */
  rMultiple: number | null;
  /** Realized PnL in quote currency (human units) */
  pnl: number;
  label: number | null;
  /** MFE as percent of entry (human units, e.g. 1.5 = 1.5%) */
  mfe: number;
  /** MAE as percent of entry (human units, typically negative or absolute depending on storage) */
  mae: number;
  durationMs: number;
  timeToMFEMs: number;
  timeToMAEMs: number;
  wasTaken: boolean;
  mlPredictedLabel: number | null;
  mlPredictedConfidence: number | null;
}

export interface DataQualityIssue {
  code: string;
  count: number;
  description: string;
  /** Whether rows with this issue were excluded from performance metrics */
  excluded: boolean;
}

export interface DataQualityAudit {
  rowsExamined: number;
  rowsIncluded: number;
  rowsExcluded: number;
  issues: DataQualityIssue[];
  openSimulations: number;
  duplicateSignalIds: number;
}

export interface PerformanceMetrics {
  tradeCount: number;
  buyCount: number;
  sellCount: number;
  winCount: number;
  lossCount: number;
  winRate: number; // 0–100
  averageR: number;
  medianR: number;
  grossProfitR: number;
  grossLossR: number;
  profitFactor: number | null; // null if no losses
  totalR: number;
  totalRealizedPnl: number;
  averageMFE: number;
  medianMFE: number;
  averageMAE: number;
  medianMAE: number;
  mfeMaeRatio: number | null;
  averageTimeToMFEMs: number;
  averageTimeToMAEMs: number;
  maxDrawdownR: number;
}

export interface GroupMetrics extends PerformanceMetrics {
  key: string;
  lowSample?: boolean;
}

export interface TakenVsAllMetrics {
  all: PerformanceMetrics;
  taken: PerformanceMetrics;
  totalCount: number;
  takenCount: number;
  percentageTaken: number;
}

export interface DrawdownMethodology {
  orderingField: 'closedAt';
  startingEquityR: number;
  openTradesExcluded: true;
  simultaneousTradesTreatedIndependently: true;
  description: string;
}

export interface BaselineReportMeta {
  repository: string;
  gitCommitSha: string;
  reportGeneratedAt: string;
  dataCutoffTimestamp: string | null;
  datasetDefinition: string;
  queryMethodology: string;
  rowsExamined: number;
  rowsIncluded: number;
  rowsExcluded: number;
  exclusionReasons: string[];
}

export interface BaselineReport {
  meta: BaselineReportMeta;
  dataQuality: DataQualityAudit;
  overall: PerformanceMetrics;
  buyVsSell: {
    buy: PerformanceMetrics;
    sell: PerformanceMetrics;
  };
  bySymbol: GroupMetrics[];
  byRegime: GroupMetrics[];
  byConfidenceBucket: GroupMetrics[];
  byMlLabel: GroupMetrics[];
  byMlPredictedLabel: GroupMetrics[];
  byHoldingTime: GroupMetrics[];
  takenVsAll: TakenVsAllMetrics;
  drawdownMethodology: DrawdownMethodology;
  equityCurve: Array<{ closedAt: number; cumulativeR: number; drawdownR: number }>;
  observations: string[];
  baselineReference: Record<string, number | string | null>;
}
