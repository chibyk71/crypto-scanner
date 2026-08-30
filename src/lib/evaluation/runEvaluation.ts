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
  type EngineEvaluationResult,
  type EvaluationAssumptions,
  type EvaluationManifest,
  type EvaluatedTrade,
  type HistoricalCandle,
  type HistoricalComparisonResult,
} from './types';

/** Stub ML: never ready → legacy path runs without ML bonus. */
export class StubMLService {
  isReady(): boolean {
    return false;
  }
  async extractFeatures(): Promise<number[]> {
    return [];
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

/** Coarse HTF aggregate when no separate HTF series is supplied. */
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
      const down = downsampleToHtf(
        candles.slice(0, t + 1),
        Math.max(5, Math.floor(minP / 50))
      );
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
      signal = runRegimeEngine(input).signal;
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

  const baselineRows = tradesToBaselineRows(trades);
  const metrics =
    baselineRows.length > 0 ? computePerformanceMetrics(baselineRows) : null;

  return {
    engine,
    trades,
    holdCount,
    warmUpSkipped,
    decisionsAttempted,
    metrics,
    baselineRows,
  };
}

function tradesToBaselineRows(trades: EvaluatedTrade[]): BaselineTradeRow[] {
  return trades.map((t, i) => ({
    id: i + 1,
    signalId: `${t.engine}-${t.decisionTimestamp}-${t.side}`,
    symbol: t.symbol,
    side: t.side,
    regime: t.regime,
    confidence: t.confidence,
    openedAt: t.entryTimestamp,
    closedAt: t.exitTimestamp,
    outcome: t.outcome === 'incomplete' ? 'timeout' : t.outcome,
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
  }));
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
  };

  return {
    manifest,
    assumptions,
    legacy,
    regime,
    disclaimer:
      'This evaluation harness measures current legacy vs regime behavior on the supplied historical candles. ' +
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
