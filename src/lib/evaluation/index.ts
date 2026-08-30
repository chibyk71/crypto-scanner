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
  SimulationOutcome,
} from './types';

export {
  DEFAULT_EVALUATION_ASSUMPTIONS,
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
  StubMLService,
  StubExchangeService,
} from './runEvaluation';
export type { RunHistoricalComparisonOptions } from './runEvaluation';
