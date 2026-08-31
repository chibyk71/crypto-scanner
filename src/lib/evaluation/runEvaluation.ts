// src/lib/evaluation/runEvaluation.ts
// Historical evaluation harness: replay identical candles through legacy + regime.
// Does NOT change strategy rules. Measurement infrastructure only.

import { createHash } from 'crypto';
import type { OhlcvData, TradeSignal } from '../../types';
import { computePerformanceMetrics } from '../baseline/metrics';
import type { BaselineTradeRow } from '../baseline/types';
import { runRegimeEngine } from '../strategy/engines/regime/engine';
import type { StrategyEngineId } from '../strategy/engines/types';
import type { StrategyInput } from '../strategy/types';
import { Strategy } from '../strategy';
import type { MLService } from '../services/mlService';
import type { ExchangeService } from '../services/exchange';
import {
  candlesToOhlcvData,
  validateHistoricalCandles,
} from './validateCandles';
import { resolveTradeOffline } from './offlineSimulate';
import {
  DEFAULT_EVALUATION_ASSUMPTIONS,
  LEGACY_CONTROL_DESCRIPTION,
  LEGACY_CONTROL_VARIANT,
  type EngineEvaluationResult,
  type EvaluationAssumptions,
  type EvaluationManifest,
  type EvaluatedTrade,
  type HistoricalCandle,
  type HistoricalComparisonResult,
} from './types';

/**
 * Stub ML: never ready → production ML-unavailable branch in computeScores:
 * no prediction bonus/penalty, and buy/sell scores × ML_CONFIDENCE_DISCOUNT (0.8).
 * Does not claim to replay production with a loaded ONNX model.
 */
export class StubMLService {
  isReady(): boolean {
    return false;
  }
  /** Neutral 33-vector so regime-engine simulate path is not skipped. */
  async extractFeatures(): Promise<number[]> {
    return new Array(33).fill(0);
  }
  async predict(): Promise<{ label: 0; confidence: 0 }> {
    return { label: 0, confidence: 0 };
  }
}

/** Stub exchange: neutral order-book (no historical book). */
export class StubExchangeService {
  async getOrderBookImbalance(): Promise<{
    imbalance: number;
    bidVolume: number;
    askVolume: number;
  }> {
    return { imbalance: 0, bidVolume: 0, askVolume: 0 };
  }
  async getOHLCV(): Promise<OhlcvData | null> {
    return null;
  }
}

function contentHash(candles: HistoricalCandle[]): string {
  const payload = candles
    .map(
      (c) =>
        `${c.timestamp}:${c.open}:${c.high}:${c.low}:${c.close}:${c.volume}`
    )
    .join('|');
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

/** Causal OhlcvData window: candles[0..endInclusive] only. */
export function causalWindow(
  candles: HistoricalCandle[],
  endInclusive: number
): OhlcvData {
  return candlesToOhlcvData(candles.slice(0, endInclusive + 1));
}

/**
 * Coarse HTF aggregate when no separate HTF series is supplied.
 *
 * Causality convention:
 * - Only complete buckets of exactly `ratio` primary bars emit an HTF candle.
 * - Bucket ending at primary index i uses primary[i-ratio+1 .. i] inclusive.
 * - Trailing primary bars that do not fill a full bucket are omitted (not a
 *   partial "live" HTF bar). Therefore when called on primary[0..T], no
 *   primary bar after T can appear in any emitted HTF candle.
 * - HTF candle timestamp = last primary bar timestamp in the bucket.
 */
export function downsampleToHtf(
  primary: HistoricalCandle[],
  ratio: number
): HistoricalCandle[] {
  if (ratio <= 1) return primary.map((c) => ({ ...c }));
  const out: HistoricalCandle[] = [];
  for (let i = ratio - 1; i < primary.length; i += ratio) {
    const chunk = primary.slice(i - ratio + 1, i + 1);
    const first = chunk[0]!;
    const last = chunk[chunk.length - 1]!;
    out.push({
      symbol: last.symbol,
      timeframe: `agg${ratio}x`,
      timestamp: last.timestamp,
      open: first.open,
      high: Math.max(...chunk.map((c) => c.high)),
      low: Math.min(...chunk.map((c) => c.low)),
      close: last.close,
      volume: chunk.reduce((s, c) => s + c.volume, 0),
    });
  }
  return out;
}

/**
 * Infer primary→HTF bar ratio from timeframe labels (e.g. 3m + 15m → 5).
 * Matches production ExchangeService.toTimeframeMs units (m/h/d).
 * Returns null if labels are unparseable or HTF is not an integer multiple.
 */
export function inferHtfAggregationRatio(
  primaryTimeframe: string,
  htfTimeframe: string
): number | null {
  const toMs = (tf: string): number | null => {
    const m = tf.trim().match(/^(\d+)([mhd])$/i);
    if (!m) return null;
    const v = parseInt(m[1]!, 10);
    const u = m[2]!.toLowerCase();
    if (u === 'm') return v * 60_000;
    if (u === 'h') return v * 3_600_000;
    return v * 86_400_000;
  };
  const p = toMs(primaryTimeframe);
  const h = toMs(htfTimeframe);
  if (p == null || h == null || p <= 0 || h < p) return null;
  const ratio = h / p;
  if (!Number.isInteger(ratio) || ratio < 1) return null;
  return ratio;
}

function buildStrategyInput(
  symbol: string,
  primary: OhlcvData,
  htf: OhlcvData,
  price: number,
  assumptions: EvaluationAssumptions
): StrategyInput {
  return {
    symbol,
    primaryData: primary,
    htfData: htf,
    price,
    atrMultiplier: assumptions.atrMultiplier,
    riskRewardTarget: assumptions.riskRewardTarget,
    trailingStopPercent: assumptions.trailingStopPercent,
    requireAtrFeasibility: true,
  };
}

async function runEngineOnSeries(
  engine: StrategyEngineId,
  candles: HistoricalCandle[],
  htfCandles: HistoricalCandle[] | null,
  assumptions: EvaluationAssumptions,
  legacyStrategy: Strategy | null
): Promise<EngineEvaluationResult> {
  const trades: EvaluatedTrade[] = [];
  let holdCount = 0;
  let warmUpSkipped = 0;
  let decisionsAttempted = 0;
  const minP = assumptions.minPrimaryBars;
  // Stub ML for regime path feature extraction only (no predict on decision path).
  const mlService = new StubMLService() as unknown as MLService;

  for (let t = 0; t < candles.length; t++) {
    if (t + 1 < minP) {
      warmUpSkipped++;
      continue;
    }

    // Causal window: only bars 0..t (inclusive) — no future leak
    const primaryWin = causalWindow(candles, t);
    let htfWin: OhlcvData;
    if (htfCandles != null) {
      const decisionTs = candles[t]!.timestamp;
      const htfUpTo = htfCandles.filter((c) => c.timestamp <= decisionTs);
      if (htfUpTo.length < assumptions.minHtfBars) {
        warmUpSkipped++;
        continue;
      }
      htfWin = candlesToOhlcvData(htfUpTo);
    } else {
      // Synthetic HTF: production-aligned ratio (default 3m→15m = 5),
      // NOT derived from minPrimaryBars / warm-up.
      const ratio = Math.max(1, assumptions.htfAggregationRatio);
      const down = downsampleToHtf(candles.slice(0, t + 1), ratio);
      if (down.length < assumptions.minHtfBars) {
        warmUpSkipped++;
        continue;
      }
      htfWin = candlesToOhlcvData(down);
    }

    decisionsAttempted++;
    const price = candles[t]!.close;
    const input = buildStrategyInput(
      candles[t]!.symbol,
      primaryWin,
      htfWin,
      price,
      assumptions
    );

    let signal: TradeSignal;
    if (engine === 'regime') {
      // Independent regime path — never enters legacy scoring
      signal = (await runRegimeEngine(input, mlService as MLService)).signal;
    } else {
      if (!legacyStrategy) {
        throw new Error('Legacy engine requires Strategy instance');
      }
      // Force legacy path for this call only
      const prev = process.env.STRATEGY_ENGINE;
      process.env.STRATEGY_ENGINE = 'legacy';
      try {
        signal = await legacyStrategy.generateSignal(input);
      } finally {
        if (prev === undefined) delete process.env.STRATEGY_ENGINE;
        else process.env.STRATEGY_ENGINE = prev;
      }
    }

    if (signal.signal === 'hold') {
      holdCount++;
      continue;
    }

    trades.push(
      resolveTradeOffline({
        engine,
        signal,
        decisionIndex: t,
        candles,
        assumptions,
      })
    );
  }

  const incompleteCount = trades.filter((t) => t.incomplete).length;
  // Incomplete/censored trades stay in `trades` for audit but are excluded from metrics.
  const completed = trades.filter((t) => !t.incomplete);
  const baselineRows = tradesToBaselineRows(completed);
  const metrics =
    baselineRows.length > 0 ? computePerformanceMetrics(baselineRows) : null;

  return {
    engine,
    trades,
    holdCount,
    warmUpSkipped,
    decisionsAttempted,
    incompleteCount,
    metrics,
    baselineRows,
  };
}

/**
 * Map completed evaluation trades to baseline rows.
 * Callers must pass only completed trades — incomplete must not be coerced to timeout.
 */
function tradesToBaselineRows(trades: EvaluatedTrade[]): BaselineTradeRow[] {
  return trades.map((t, i) => {
    if (t.incomplete || t.outcome === 'incomplete') {
      throw new Error(
        'tradesToBaselineRows: incomplete trades must not enter completed-trade metrics'
      );
    }
    return {
      id: i + 1,
      signalId: `${t.engine}-${t.decisionTimestamp}-${t.side}`,
      symbol: t.symbol,
      side: t.side,
      regime: t.regime,
      confidence: t.confidence,
      openedAt: t.entryTimestamp,
      closedAt: t.exitTimestamp,
      outcome: t.outcome,
      rMultiple: t.rMultiple,
      pnl: t.pnl,
      label: null,
      mfe: t.mfe,
      mae: t.mae,
      durationMs: t.durationMs,
      timeToMFEMs: 0,
      timeToMAEMs: 0,
      wasTaken: true,
      mlPredictedLabel: null,
      mlPredictedConfidence: null,
    };
  });
}

export interface RunHistoricalComparisonOptions {
  candles: HistoricalCandle[];
  htfCandles?: HistoricalCandle[];
  assumptions?: Partial<EvaluationAssumptions>;
  manifestLabel?: string;
  gitSha?: string;
  legacyStrategy?: Strategy;
}

/**
 * Run BOTH engines independently on the same validated candle stream.
 * Does not enable regime as production default. Does not use simulated_trades.csv.
 */
export async function runHistoricalComparison(
  options: RunHistoricalComparisonOptions
): Promise<HistoricalComparisonResult> {
  const validation = validateHistoricalCandles(options.candles);
  if (!validation.ok) {
    const msg = validation.issues.map((i) => i.message).join('; ');
    throw new Error(`Historical candle validation failed: ${msg}`);
  }
  const candles = validation.candles;

  let htfCandles: HistoricalCandle[] | null = null;
  if (options.htfCandles != null && options.htfCandles.length > 0) {
    const htfVal = validateHistoricalCandles(options.htfCandles);
    if (!htfVal.ok) {
      const msg = htfVal.issues.map((i) => i.message).join('; ');
      throw new Error(`HTF candle validation failed: ${msg}`);
    }
    htfCandles = htfVal.candles;
  }

  const assumptions: EvaluationAssumptions = {
    ...DEFAULT_EVALUATION_ASSUMPTIONS,
    ...options.assumptions,
  };

  if (candles.length < assumptions.minPrimaryBars) {
    throw new Error(
      `Insufficient primary candles for warm-up: have ${candles.length}, ` +
        `require minPrimaryBars=${assumptions.minPrimaryBars} ` +
        `(DEFAULT_EVALUATION_ASSUMPTIONS.minPrimaryBars=` +
        `${DEFAULT_EVALUATION_ASSUMPTIONS.minPrimaryBars}). ` +
        `Supply more history or explicitly override assumptions.minPrimaryBars.`
    );
  }

  const symbol = candles[0]!.symbol;
  const timeframe = candles[0]!.timeframe;

  const legacyStrategy =
    options.legacyStrategy ??
    new Strategy(
      new StubMLService() as unknown as MLService,
      new StubExchangeService() as unknown as ExchangeService
    );

  const legacy = await runEngineOnSeries(
    'legacy',
    candles,
    htfCandles,
    assumptions,
    legacyStrategy
  );
  const regime = await runEngineOnSeries(
    'regime',
    candles,
    htfCandles,
    assumptions,
    null
  );

  const htfSource =
    htfCandles != null ? 'provided_series' : 'synthetic_aggregate';

  const manifest: EvaluationManifest = {
    label: options.manifestLabel ?? `${symbol}-${timeframe}`,
    symbol,
    timeframe,
    rangeStartMs: candles[0]?.timestamp ?? null,
    rangeEndMs: candles[candles.length - 1]?.timestamp ?? null,
    inputCandleCount: candles.length,
    contentHash: contentHash(candles),
    evaluatedAtIso: new Date().toISOString(),
    gitSha: options.gitSha,
    legacyControlVariant: LEGACY_CONTROL_VARIANT,
    legacyControlDescription: LEGACY_CONTROL_DESCRIPTION,
    htfSource,
    htfAggregationRatio: assumptions.htfAggregationRatio,
    primaryTimeframe: assumptions.primaryTimeframe,
    htfTimeframe: assumptions.htfTimeframe,
  };

  return {
    manifest,
    assumptions,
    legacyControlVariant: LEGACY_CONTROL_VARIANT,
    legacyControlDescription: LEGACY_CONTROL_DESCRIPTION,
    legacy,
    regime,
    disclaimer:
      'This evaluation harness measures regime against the explicit legacy control variant ' +
      `'${LEGACY_CONTROL_VARIANT}' (technical path; ML unavailable; book neutral). ` +
      'It does not establish that the regime strategy is profitable or superior. ' +
      'No strategy parameters were optimized against this dataset in this PR.',
  };
}

/** Deterministic fingerprint (excludes wall-clock evaluatedAtIso). */
export function stableResultFingerprint(
  result: HistoricalComparisonResult
): string {
  const payload = {
    manifest: { ...result.manifest, evaluatedAtIso: undefined },
    assumptions: result.assumptions,
    legacy: {
      engine: result.legacy.engine,
      holdCount: result.legacy.holdCount,
      warmUpSkipped: result.legacy.warmUpSkipped,
      decisionsAttempted: result.legacy.decisionsAttempted,
      trades: result.legacy.trades.map((t) => ({
        side: t.side,
        decisionTimestamp: t.decisionTimestamp,
        entryPrice: t.entryPrice,
        exitPrice: t.exitPrice,
        outcome: t.outcome,
        rMultiple: t.rMultiple,
        setupId: t.setupId,
        regime: t.regime,
      })),
    },
    regime: {
      engine: result.regime.engine,
      holdCount: result.regime.holdCount,
      warmUpSkipped: result.regime.warmUpSkipped,
      decisionsAttempted: result.regime.decisionsAttempted,
      trades: result.regime.trades.map((t) => ({
        side: t.side,
        decisionTimestamp: t.decisionTimestamp,
        entryPrice: t.entryPrice,
        exitPrice: t.exitPrice,
        outcome: t.outcome,
        rMultiple: t.rMultiple,
        setupId: t.setupId,
        regime: t.regime,
      })),
    },
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}
