// src/lib/evaluation/index.ts
// Historical evaluation harness public surface.
// Measurement infrastructure only — does not change strategy behavior.

export type {
  CandleValidationIssue,
  CandleValidationResult,
  EngineEvaluationResult,
  EvaluationAssumptions,
  EvaluationManifest,
  EvaluatedTrade,
  HistoricalCandle,
  HistoricalComparisonResult,
  LegacyControlVariant,
  SimulationOutcome,
} from './types';

export {
  DEFAULT_EVALUATION_ASSUMPTIONS,
  LEGACY_CONTROL_DESCRIPTION,
  LEGACY_CONTROL_VARIANT,
} from './types';

export {
  validateHistoricalCandles,
  candlesToOhlcvData,
} from './validateCandles';

export { resolveTradeOffline, applySlippage } from './offlineSimulate';

export {
  runHistoricalComparison,
  stableResultFingerprint,
  causalWindow,
  downsampleToHtf,
  inferHtfAggregationRatio,
  StubMLService,
  StubExchangeService,
} from './runEvaluation';
export type { RunHistoricalComparisonOptions } from './runEvaluation';
