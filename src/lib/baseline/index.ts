// src/lib/baseline/index.ts
// Phase 0 — Public surface for baseline measurement (no strategy logic).

export type {
  BaselineReport,
  BaselineReportMeta,
  BaselineTradeRow,
  DataQualityAudit,
  DataQualityIssue,
  DrawdownMethodology,
  GroupMetrics,
  PerformanceMetrics,
  TakenVsAllMetrics,
} from './types';

export {
  auditDataQuality,
  buildEquityCurve,
  computeMaxDrawdownR,
  computePerformanceMetrics,
  confidenceBucket,
  DRAWDOWN_METHODOLOGY,
  groupBy,
  holdingTimeBucket,
  isWin,
} from './metrics';

export { buildBaselineReport, formatBaselineMarkdown } from './report';
export { loadBaselineRowsFromDb, normalizeExportRow } from './loadFromDb';
