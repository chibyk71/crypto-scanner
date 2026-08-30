// src/lib/evaluation/validateCandles.ts
// Strict historical candle validation. Does not silently sort bad input.

import type {
  CandleValidationIssue,
  CandleValidationResult,
  HistoricalCandle,
} from './types';

function isFinitePositive(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

function isFiniteNonNeg(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

/**
 * Validate a historical OHLCV sequence.
 *
 * Rules:
 * - Non-empty
 * - Every candle has required fields with finite values
 * - high >= low, high >= open, high >= close, low <= open, low <= close
 * - timestamps strictly increasing (no duplicates, no out-of-order)
 * - Does NOT auto-sort; reports OUT_OF_ORDER / DUPLICATE_TIMESTAMP
 */
export function validateHistoricalCandles(
  input: HistoricalCandle[]
): CandleValidationResult {
  const issues: CandleValidationIssue[] = [];

  if (!Array.isArray(input) || input.length === 0) {
    return {
      ok: false,
      issues: [{ code: 'EMPTY', message: 'Input candle array is empty or not an array' }],
      candles: [],
    };
  }

  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (!c || typeof c !== 'object') {
      issues.push({
        code: 'MISSING_FIELD',
        index: i,
        message: `Candle at index ${i} is missing or not an object`,
      });
      continue;
    }

    if (typeof c.symbol !== 'string' || c.symbol.length === 0) {
      issues.push({
        code: 'MISSING_FIELD',
        index: i,
        message: `Candle ${i}: symbol must be a non-empty string`,
      });
    }
    if (typeof c.timeframe !== 'string' || c.timeframe.length === 0) {
      issues.push({
        code: 'MISSING_FIELD',
        index: i,
        message: `Candle ${i}: timeframe must be a non-empty string`,
      });
    }

    if (
      typeof c.timestamp !== 'number' ||
      !Number.isFinite(c.timestamp) ||
      c.timestamp <= 0
    ) {
      issues.push({
        code: 'INVALID_TIMESTAMP',
        index: i,
        message: `Candle ${i}: timestamp must be a finite positive number (ms)`,
      });
    }

    if (
      !isFinitePositive(c.open) ||
      !isFinitePositive(c.high) ||
      !isFinitePositive(c.low) ||
      !isFinitePositive(c.close)
    ) {
      issues.push({
        code: 'INVALID_OHLCV',
        index: i,
        message: `Candle ${i}: open/high/low/close must be finite and > 0`,
      });
    } else if (
      c.high < c.low ||
      c.high < c.open ||
      c.high < c.close ||
      c.low > c.open ||
      c.low > c.close
    ) {
      issues.push({
        code: 'INVALID_OHLCV',
        index: i,
        message: `Candle ${i}: OHLC consistency failed (high/low vs open/close)`,
      });
    }

    if (!isFiniteNonNeg(c.volume)) {
      issues.push({
        code: 'INVALID_OHLCV',
        index: i,
        message: `Candle ${i}: volume must be finite and >= 0`,
      });
    }
  }

  // Chronology only if structure is otherwise usable
  if (issues.length === 0) {
    for (let i = 1; i < input.length; i++) {
      const prev = input[i - 1]!.timestamp;
      const cur = input[i]!.timestamp;
      if (cur === prev) {
        issues.push({
          code: 'DUPLICATE_TIMESTAMP',
          index: i,
          message: `Candle ${i}: duplicate timestamp ${cur} (same as index ${i - 1})`,
        });
      } else if (cur < prev) {
        issues.push({
          code: 'OUT_OF_ORDER',
          index: i,
          message: `Candle ${i}: timestamp ${cur} is before previous ${prev} (not chronological)`,
        });
      }
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues, candles: [] };
  }

  // Defensive copy — validated chronological sequence
  const candles = input.map((c) => ({ ...c }));
  return { ok: true, issues: [], candles };
}

/**
 * Convert validated candles to OhlcvData (project core type).
 * Caller must ensure validateHistoricalCandles succeeded.
 */
export function candlesToOhlcvData(
  candles: HistoricalCandle[],
  symbol?: string
): import('../../types').OhlcvData {
  return {
    symbol: symbol ?? candles[0]?.symbol,
    timestamps: candles.map((c) => c.timestamp),
    opens: candles.map((c) => c.open),
    highs: candles.map((c) => c.high),
    lows: candles.map((c) => c.low),
    closes: candles.map((c) => c.close),
    volumes: candles.map((c) => c.volume),
    length: candles.length,
  };
}
