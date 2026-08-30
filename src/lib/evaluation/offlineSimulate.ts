// src/lib/evaluation/offlineSimulate.ts
// Deterministic offline trade lifecycle for historical evaluation.
// Mirrors simulateTrade exit priority (partial TP → full TP → SL) without live polling.
// Does not change strategy behavior.

import type { TradeSignal } from '../../types';
import type { EvaluationAssumptions, EvaluatedTrade, SimulationOutcome } from './types';
import type { HistoricalCandle } from './types';
import type { StrategyEngineId } from '../strategy/engines/types';

const FALLBACK_RISK_PCT = 0.015;
const EPSILON = 1e-8;

export interface OfflineSimInput {
  engine: StrategyEngineId;
  signal: TradeSignal;
  decisionIndex: number;
  candles: HistoricalCandle[];
  assumptions: EvaluationAssumptions;
}

function applySlippage(
  price: number,
  isLong: boolean,
  isEntry: boolean,
  rate: number
): number {
  if (rate <= 0) return price;
  if (isEntry) {
    return isLong ? price * (1 + rate) : price * (1 - rate);
  }
  return isLong ? price * (1 - rate) : price * (1 + rate);
}

export function resolveTradeOffline(input: OfflineSimInput): EvaluatedTrade {
  const { engine, signal, decisionIndex, candles, assumptions } = input;
  const isLong = signal.signal === 'buy';
  const decision = candles[decisionIndex]!;
  const entryPrice = applySlippage(decision.close, isLong, true, assumptions.slippageRate);
  const entryTimestamp = decision.timestamp;

  let remaining = 1.0;
  let totalPnl = 0;
  let bestFavorable = entryPrice;
  let bestAdverse = entryPrice;

  const stopLoss = signal.stopLoss != null && signal.stopLoss > 0 ? signal.stopLoss : null;
  const takeProfit = signal.takeProfit != null && signal.takeProfit > 0 ? signal.takeProfit : null;
  const tpLevels = signal.takeProfitLevels ?? [];

  const startIdx = decisionIndex + 1;
  const endIdx = Math.min(candles.length - 1, decisionIndex + assumptions.maxHoldBars);

  let outcome: SimulationOutcome = 'timeout';
  let exitPrice: number | null = null;
  let exitTimestamp: number | null = null;
  let incomplete = false;

  const updateExcursions = (high: number, low: number) => {
    if (isLong) {
      if (high > bestFavorable) bestFavorable = high;
      if (low < bestAdverse) bestAdverse = low;
    } else {
      if (low < bestFavorable) bestFavorable = low;
      if (high > bestAdverse) bestAdverse = high;
    }
  };

  for (let i = startIdx; i <= endIdx && remaining > 0.01; i++) {
    const bar = candles[i]!;
    updateExcursions(bar.high, bar.low);

    if (tpLevels.length > 0 && remaining > 0.01) {
      const sorted = [...tpLevels].sort((a, b) =>
        isLong ? a.price - b.price : b.price - a.price
      );
      for (const level of sorted) {
        if (remaining < level.weight - EPSILON) continue;
        const hit = isLong
          ? bar.high >= level.price - EPSILON
          : bar.low <= level.price + EPSILON;
        if (hit) {
          const pnlThis = isLong
            ? (level.price - entryPrice) / entryPrice
            : (entryPrice - level.price) / entryPrice;
          totalPnl += pnlThis * level.weight;
          remaining -= level.weight;
        }
      }
      if (remaining <= 0.01) {
        outcome = 'partial_tp';
        exitPrice = applySlippage(sorted[sorted.length - 1]!.price, isLong, false, assumptions.slippageRate);
        exitTimestamp = bar.timestamp;
        remaining = 0;
        break;
      }
    }

    if (takeProfit != null) {
      const hit = isLong
        ? bar.high >= takeProfit - EPSILON
        : bar.low <= takeProfit + EPSILON;
      if (hit) {
        const pnlThis = isLong
          ? (takeProfit - entryPrice) / entryPrice
          : (entryPrice - takeProfit) / entryPrice;
        totalPnl += pnlThis * remaining;
        remaining = 0;
        outcome = 'tp';
        exitPrice = applySlippage(takeProfit, isLong, false, assumptions.slippageRate);
        exitTimestamp = bar.timestamp;
        break;
      }
    }

    if (stopLoss != null) {
      const hit = isLong
        ? bar.low <= stopLoss + EPSILON
        : bar.high >= stopLoss - EPSILON;
      if (hit) {
        const pnlThis = isLong
          ? (stopLoss - entryPrice) / entryPrice
          : (entryPrice - stopLoss) / entryPrice;
        totalPnl += pnlThis * remaining;
        remaining = 0;
        outcome = 'sl';
        exitPrice = applySlippage(stopLoss, isLong, false, assumptions.slippageRate);
        exitTimestamp = bar.timestamp;
        break;
      }
    }
  }

  if (remaining > 0.01) {
    const lastIdx = Math.min(endIdx, candles.length - 1);
    const last = candles[Math.max(lastIdx, decisionIndex)]!;
    const mid = (last.high + last.low) / 2;
    const exitRaw = applySlippage(mid, isLong, false, assumptions.slippageRate);
    const pnlThis = isLong
      ? (exitRaw - entryPrice) / entryPrice
      : (entryPrice - exitRaw) / entryPrice;
    totalPnl += pnlThis * remaining;
    remaining = 0;
    outcome = 'timeout';
    if (startIdx >= candles.length) {
      incomplete = true;
      outcome = 'incomplete';
    }
    exitPrice = exitRaw;
    exitTimestamp = last.timestamp;
  }

  const fees = assumptions.feeRate > 0 ? assumptions.feeRate * 2 : 0;
  const pnlAfterFees = totalPnl - fees;

  let riskPct: number;
  if (stopLoss != null && stopLoss > 0) {
    riskPct = Math.max(Math.abs(entryPrice - stopLoss) / entryPrice, 0.0001);
  } else {
    riskPct = FALLBACK_RISK_PCT;
  }
  const rMultiple = pnlAfterFees / riskPct;

  const mfePct =
    ((isLong ? bestFavorable - entryPrice : entryPrice - bestFavorable) / entryPrice) * 100;
  const maePct =
    -Math.abs(((isLong ? entryPrice - bestAdverse : bestAdverse - entryPrice) / entryPrice) * 100);

  const durationMs =
    exitTimestamp != null ? Math.max(0, exitTimestamp - entryTimestamp) : 0;

  return {
    engine,
    symbol: signal.symbol,
    side: isLong ? 'buy' : 'sell',
    decisionIndex,
    decisionTimestamp: decision.timestamp,
    entryPrice,
    entryTimestamp,
    exitPrice,
    exitTimestamp,
    outcome,
    rMultiple: Number.isFinite(rMultiple) ? rMultiple : null,
    pnl: pnlAfterFees,
    mfe: Number.isFinite(mfePct) ? Math.max(0, Math.min(10000, mfePct)) : null,
    mae: Number.isFinite(maePct) ? Math.max(-10000, Math.min(0, maePct)) : null,
    durationMs,
    fees,
    regime: signal.regime ?? null,
    setupId: signal.setupId ?? null,
    confidence: signal.confidence ?? 0,
    signalReasons: [...(signal.reason ?? [])],
    incomplete,
  };
}
