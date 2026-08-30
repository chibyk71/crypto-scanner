// src/lib/evaluation/types.ts
// Historical evaluation harness types only. No strategy logic.

import type { BaselineTradeRow, PerformanceMetrics } from '../baseline/types';
import type { TradeSignal } from '../../types';
import type { StrategyEngineId } from '../strategy/engines/types';

/**
 * What the historical "legacy" arm actually measures.
 *
 * Production Strategy.generateSignal (legacy path) can apply:
 *   - ML bonus/penalty when mlService.isReady()
 *   - order-book imbalance points when |imbalance| is material and score is near threshold
 *
 * Historical OHLCV cannot reconstruct live order book or causal ML labels without
 * a separately designed, leakage-free feature pipeline (not in this PR).
 *
 * Therefore the default harness control is the technical legacy path with:
 *   - ML unavailable (isReady() === false → production branch: no prediction
 *     bonus/penalty AND buy/sell scores × ML_CONFIDENCE_DISCOUNT 0.8)
 *   - order-book imbalance neutral 0 (no points; same as production when book is
 *     unavailable or |imbalance| below threshold)
 *
 * Causal ML features/predictions cannot be rebuilt from OHLCV alone
 * (extractFeatures depends on excursion history cache + wall-clock time).
 * Live order book cannot be reconstructed from OHLCV.
 *
 * This is NOT "production with ML loaded + live book".
 * It is the frozen technical scoring/signal path under those unavailable inputs,
 * which is also the production behavior when no ONNX model is loaded and the book
 * is unavailable/neutral.
 */
export type LegacyControlVariant =
  | 'legacy_technical_ml_unavailable_book_neutral';

export const LEGACY_CONTROL_VARIANT: LegacyControlVariant =
  'legacy_technical_ml_unavailable_book_neutral';

export const LEGACY_CONTROL_DESCRIPTION =
  'Legacy arm runs Strategy.generateSignal with STRATEGY_ENGINE=legacy, ' +
  'StubMLService (isReady=false → production ML-unavailable branch: no prediction ' +
  'bonus/penalty AND technical buy/sell scores multiplied by ML_CONFIDENCE_DISCOUNT=0.8), ' +
  'and StubExchangeService (order-book imbalance 0 → no book points; same as ' +
  'unavailable book or |imbalance| below threshold). Technical scoring formulas and ' +
  'signal/risk rules are unmodified. This is NOT production with a loaded ONNX model ' +
  'or a live order book. Causal ML features cannot be reconstructed from OHLCV alone ' +
  '(extractFeatures uses excursion history cache and wall-clock time); therefore the ' +
  'harness intentionally measures the technical path under unavailable ML + neutral book.';

/**
 * Single historical OHLCV candle (one bar).
 * timestamp is Unix milliseconds (candle close time, matching OhlcvData convention).
 */
export interface HistoricalCandle {
  symbol: string;
  timeframe: string;
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * Manifest describing the evaluation dataset for reproducibility.
 */
export interface EvaluationManifest {
  /** Human label for this run (e.g. symbol + range). */
  label: string;
  symbol: string;
  timeframe: string;
  /** Inclusive start of evaluation window (ms). Decisions only after warm-up. */
  rangeStartMs: number | null;
  /** Inclusive end of evaluation window (ms). */
  rangeEndMs: number | null;
  /** Number of candles supplied (before validation trim). */
  inputCandleCount: number;
  /** SHA-256 of canonical candle payload when available. */
  contentHash?: string;
  /** ISO timestamp when evaluation was run. */
  evaluatedAtIso: string;
  /** Git commit if known. */
  gitSha?: string;
  /** Explicit legacy-control semantics for this run. */
  legacyControlVariant: LegacyControlVariant;
  /** Human-readable legacy control description. */
  legacyControlDescription: string;
}

export interface CandleValidationIssue {
  code:
    | 'OUT_OF_ORDER'
    | 'DUPLICATE_TIMESTAMP'
    | 'INVALID_TIMESTAMP'
    | 'INVALID_OHLCV'
    | 'MISSING_FIELD'
    | 'EMPTY';
  index?: number;
  message: string;
}

export interface CandleValidationResult {
  ok: boolean;
  issues: CandleValidationIssue[];
  /** Validated chronological sequence copied from input when ok (not sorted/deduped); empty when not. */
  candles: HistoricalCandle[];
}

/**
 * Execution assumptions applied identically to both engines.
 */
export interface EvaluationAssumptions {
  /**
   * Signal generated from candle T (close) enters at that candle's close.
   * Matches live scanner use of primaryData.closes.at(-1) as price.
   * No fill at open or intra-bar of T; no look-ahead to T+1 open.
   */
  entryTiming: 'decision_candle_close';
  /**
   * Outcome resolution walks subsequent candles in the same series
   * (not a separate 1m poll). Max hold is maxHoldBars bars after entry.
   */
  resolutionSeries: 'same_as_decision';
  /** Maximum bars after entry to resolve TP/SL/timeout (matches sim candle count conceptually). */
  maxHoldBars: number;
  /** Fee rate as fraction of notional per side (0 = none; matches current simulateTrade). */
  feeRate: number;
  /** Slippage as fraction of price applied adversely on entry and exit (0 = none). */
  slippageRate: number;
  /**
   * Concurrent positions: independent (new signals while one is open are allowed).
   * Matches live fire-and-forget simulateTrade behavior.
   */
  overlappingPositions: 'independent';
  /**
   * Same-bar TP and SL: check order matches simulateTrade —
   * partial TP levels first, then full TP, then SL.
   */
  sameBarPriority: 'partial_tp_then_tp_then_sl';
  /**
   * End of dataset with open position: force timeout at last bar midpoint.
   */
  endOfData: 'timeout_midpoint';
  /** Minimum primary candles before any decision (indicator warm-up). */
  minPrimaryBars: number;
  /** Minimum HTF bars when HTF series provided. */
  minHtfBars: number;
  /** ATR multiplier for SL (matches settings default 1.5). */
  atrMultiplier: number;
  /** Risk:reward target (matches settings default 3.0). */
  riskRewardTarget: number;
  /** Trailing stop percent (matches settings default 0.10). */
  trailingStopPercent: number;
}

export const DEFAULT_EVALUATION_ASSUMPTIONS: EvaluationAssumptions = {
  entryTiming: 'decision_candle_close',
  resolutionSeries: 'same_as_decision',
  maxHoldBars: 10,
  feeRate: 0,
  slippageRate: 0,
  overlappingPositions: 'independent',
  sameBarPriority: 'partial_tp_then_tp_then_sl',
  endOfData: 'timeout_midpoint',
  // Align with config.historyLength default (300) and EMA-200 needs.
  minPrimaryBars: 300,
  minHtfBars: 50,
  atrMultiplier: 1.5,
  riskRewardTarget: 3.0,
  trailingStopPercent: 0.1,
};

export type SimulationOutcome = 'tp' | 'partial_tp' | 'sl' | 'timeout' | 'incomplete';

export interface EvaluatedTrade {
  engine: StrategyEngineId;
  symbol: string;
  side: 'buy' | 'sell';
  /** Decision candle index in the validated series. */
  decisionIndex: number;
  decisionTimestamp: number;
  entryPrice: number;
  entryTimestamp: number;
  exitPrice: number | null;
  exitTimestamp: number | null;
  outcome: SimulationOutcome;
  rMultiple: number | null;
  pnl: number;
  mfe: number | null;
  mae: number | null;
  durationMs: number;
  fees: number;
  regime: string | null;
  setupId: string | null;
  confidence: number;
  signalReasons: string[];
  /** True when forced closed at end of data without natural exit. */
  incomplete: boolean;
}

export interface EngineEvaluationResult {
  engine: StrategyEngineId;
  trades: EvaluatedTrade[];
  /** Decisions that produced hold (for frequency diagnostics). */
  holdCount: number;
  /** Bars skipped due to warm-up. */
  warmUpSkipped: number;
  /** Bars evaluated (decision attempts after warm-up). */
  decisionsAttempted: number;
  metrics: PerformanceMetrics | null;
  baselineRows: BaselineTradeRow[];
}

export interface HistoricalComparisonResult {
  manifest: EvaluationManifest;
  assumptions: EvaluationAssumptions;
  /** Explicit: what the legacy arm measures under historical constraints. */
  legacyControlVariant: LegacyControlVariant;
  legacyControlDescription: string;
  legacy: EngineEvaluationResult;
  regime: EngineEvaluationResult;
  /**
   * Explicit statement: this object is measurement infrastructure output only.
   * It does not establish profitability or superiority of either engine.
   */
  disclaimer: string;
}

export interface SignalAtBar {
  index: number;
  timestamp: number;
  price: number;
  signal: TradeSignal;
}
