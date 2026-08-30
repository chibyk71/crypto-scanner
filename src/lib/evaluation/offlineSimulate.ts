// src/lib/evaluation/offlineSimulate.ts
// Deterministic offline trade lifecycle for historical evaluation.
// Mirrors simulateTrade exit priority (partial TP → full TP → SL) without live polling.
// Does not change strategy behavior.
//
// Slippage rule (identical for LONG/SHORT, all exit types):
//   1. Derive executed entry from raw decision close + adverse slippage.
//   2. On exit, derive executed exit from raw TP/SL/timeout price + adverse slippage.
//   3. Realize P&L (and R) only from executed exit vs executed entry.
//   4. Apply fees to that realized P&L.

import type { TradeSignal } from '../../types';
import type { EvaluationAssumptions, EvaluatedTrade, SimulationOutcome } from './types';
import type { HistoricalCandle } from './types';
import type { StrategyEngineId } from '../strategy/engines/types';

const FALLBACK_RISK_PCT = 0.015;
const EPSILON = 1e-8;

export interface OfflineSimInput {
  engine: StrategyEngineId;
  signal: TradeSignal;
  /** Index of decision candle in the full series. */
  decisionIndex: number;
  candles: HistoricalCandle[];
  assumptions: EvaluationAssumptions;
}

/**
 * Adverse slippage on a raw price.
 * Entry long / exit short → pay up; entry short / exit long → sell down.
 */
export function applySlippage(
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

/** Realized fractional P&L from executed prices (before fees). */
function pnlFromExecuted(
  isLong: boolean,
  executedEntry: number,
  executedExit: number
): number {
  return isLong
    ? (executedExit - executedEntry) / executedEntry
    : (executedEntry - executedExit) / executedEntry;
}

/**
 * Resolve one trade offline from decision candle onward.
 *
 * Entry: decision candle close → adverse slippage → executed entry.
 * Exit: raw TP/SL/timeout → adverse slippage → executed exit; P&L from executed prices.
 * Same-bar priority: partial TP → full TP → SL (matches simulateTrade).
 * End of data: timeout at last bar midpoint.
 */
export function resolveTradeOffline(input: OfflineSimInput): EvaluatedTrade {
  const { engine, signal, decisionIndex, candles, assumptions } = input;
  const isLong = signal.signal === 'buy';
  const decision = candles[decisionIndex]!;
  const rawEntry = decision.close;
  const entryPrice = applySlippage(
    rawEntry,
    isLong,
    true,
    assumptions.slippageRate
  );
  const entryTimestamp = decision.timestamp;

  let remaining = 1.0;
  let totalPnl = 0;
  let bestFavorable = entryPrice;
  let bestAdverse = entryPrice;

  const stopLoss =
    signal.stopLoss != null && signal.stopLoss > 0 ? signal.stopLoss : null;
  const takeProfit =
    signal.takeProfit != null && signal.takeProfit > 0 ? signal.takeProfit : null;
  const tpLevels = signal.takeProfitLevels ?? [];

  const startIdx = decisionIndex + 1;
  const endIdx = Math.min(
    candles.length - 1,
    decisionIndex + assumptions.maxHoldBars
  );

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

  const realizeAt = (rawExit: number, weight: number): number => {
    const executedExit = applySlippage(
      rawExit,
      isLong,
      false,
      assumptions.slippageRate
    );
    return pnlFromExecuted(isLong, entryPrice, executedExit) * weight;
  };

  for (let i = startIdx; i <= endIdx && remaining > 0.01; i++) {
    const bar = candles[i]!;
    updateExcursions(bar.high, bar.low);

    if (tpLevels.length > 0 && remaining > 0.01) {
      const sorted = [...tpLevels].sort((a, b) =>
        isLong ? a.price - b.price : b.price - a.price
      );
      let lastExecutedPartial: number | null = null;
      for (const level of sorted) {
        if (remaining < level.weight - EPSILON) continue;
        const hit = isLong
          ? bar.high >= level.price - EPSILON
          : bar.low <= level.price + EPSILON;
        if (hit) {
          totalPnl += realizeAt(level.price, level.weight);
          remaining -= level.weight;
          lastExecutedPartial = applySlippage(
            level.price,
            isLong,
            false,
            assumptions.slippageRate
          );
        }
      }
      if (remaining <= 0.01) {
        outcome = 'partial_tp';
        exitPrice = lastExecutedPartial;
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
        totalPnl += realizeAt(takeProfit, remaining);
        const executedExit = applySlippage(
          takeProfit,
          isLong,
          false,
          assumptions.slippageRate
        );
        remaining = 0;
        outcome = 'tp';
        exitPrice = executedExit;
        exitTimestamp = bar.timestamp;
        break;
      }
    }

    if (stopLoss != null) {
      const hit = isLong
        ? bar.low <= stopLoss + EPSILON
        : bar.high >= stopLoss - EPSILON;
      if (hit) {
        totalPnl += realizeAt(stopLoss, remaining);
        const executedExit = applySlippage(
          stopLoss,
          isLong,
          false,
          assumptions.slippageRate
        );
        remaining = 0;
        outcome = 'sl';
        exitPrice = executedExit;
        exitTimestamp = bar.timestamp;
        break;
      }
    }
  }

  if (remaining > 0.01) {
    const lastIdx = Math.min(endIdx, candles.length - 1);
    const last = candles[Math.max(lastIdx, decisionIndex)]!;
    const mid = (last.high + last.low) / 2;
    totalPnl += realizeAt(mid, remaining);
    const executedExit = applySlippage(
      mid,
      isLong,
      false,
      assumptions.slippageRate
    );
    remaining = 0;
    outcome = 'timeout';
    if (startIdx >= candles.length) {
      incomplete = true;
      outcome = 'incomplete';
    }
    exitPrice = executedExit;
    exitTimestamp = last.timestamp;
  }

  const fees =
    assumptions.feeRate > 0 ? assumptions.feeRate * 2 : 0;
  const pnlAfterFees = totalPnl - fees;

  let riskPct: number;
  if (stopLoss != null && stopLoss > 0) {
    riskPct = Math.max(Math.abs(entryPrice - stopLoss) / entryPrice, 0.0001);
  } else {
    riskPct = FALLBACK_RISK_PCT;
  }
  const rMultiple = pnlAfterFees / riskPct;

  const mfePct =
    ((isLong ? bestFavorable - entryPrice : entryPrice - bestFavorable) /
      entryPrice) *
    100;
  const maePct =
    -Math.abs(
      ((isLong ? entryPrice - bestAdverse : bestAdverse - entryPrice) /
        entryPrice) *
        100
    );

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
