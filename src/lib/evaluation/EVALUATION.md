# Historical Evaluation Harness

**Purpose:** Measure the independent regime/setup strategy against an explicit **legacy control variant** on identical, chronological historical OHLCV data.

**This module is evaluation infrastructure only.** It does **not** establish that the regime strategy is profitable or superior. No strategy parameters were optimized against evaluation data in this work.

## Legacy control semantics (required reading)

Production `Strategy.generateSignal` (legacy path) may apply:

1. **ML bonus/penalty** when `mlService.isReady()` is true (ONNX model loaded).
2. **Order-book imbalance points** when leading score is near the confidence threshold and `|imbalance|` is material.

Historical OHLCV alone cannot reconstruct:

- live order-book imbalance at decision time, or
- leakage-free ML features/predictions without a dedicated causal ML replay pipeline (out of scope for this PR).

Therefore the harness **does not** claim to replay "production with ML + live book."

### Control variant actually measured

| Field | Value |
|-------|--------|
| `legacyControlVariant` | `legacy_technical_ml_unavailable_book_neutral` |
| Strategy engine | `STRATEGY_ENGINE=legacy` → unmodified `Strategy.generateSignal` body |
| ML | `StubMLService.isReady() === false` → **no** ML bonus (same branch as production when no ONNX model is loaded) |
| Order book | `StubExchangeService` imbalance **0** → **no** book points (same as unavailable book or below threshold) |
| Technical scoring / signal / risk | **Unmodified** legacy source |

Regime arm still uses independent `runRegimeEngine` (no legacy scoring).

## Input format

```ts
interface HistoricalCandle {
  symbol: string;
  timeframe: string;
  timestamp: number; // Unix ms, chronological close time
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}
```

Validation rejects (does **not** silently sort or dedupe). Successful validation returns a **copy of the chronological input sequence**.

## Warm-up convention

| Parameter | Default (`DEFAULT_EVALUATION_ASSUMPTIONS`) |
|-----------|--------------------------------------------|
| `minPrimaryBars` | **300** |
| `minHtfBars` | **50** |

- Defaults are **not** reduced based on dataset length.
- If `candles.length < minPrimaryBars`, `runHistoricalComparison` **throws** with a clear error.
- Override only via explicit `assumptions.minPrimaryBars` / `minHtfBars` (or CLI env `EVAL_MIN_PRIMARY_BARS`, etc.).

## HTF convention (when no separate HTF series)

`downsampleToHtf(primary[0..T], ratio)`:

- Emits only **complete** buckets of exactly `ratio` primary bars.
- Bucket ending at index `i` uses primary `[i-ratio+1 .. i]` only.
- Trailing incomplete primary bars are **omitted** (not treated as a finished HTF candle).
- HTF timestamp = last primary bar in the bucket → always ≤ decision time T when primary is sliced to T.

## Assumptions (identical for both engines)

| Topic | Convention |
|-------|------------|
| Entry timing | Signal on candle **T** enters at **T close**. |
| Slippage | Adverse on entry/exit; **P&L and R from executed prices only**. |
| Fees | After executed-price P&L. |
| Look-ahead | Decision at T uses only candles `0..T`. |
| Same-bar TP/SL | partial TP → full TP → SL. |
| Overlaps | Independent. |
| End of data | Timeout midpoint / incomplete. |

## Fresh evaluation data

1. Supply chronological `HistoricalCandle[]` with **≥ 300** primary bars (or explicit warm-up override).
2. Manifest records range, content hash, and `legacyControlVariant`.
3. **Do not** use `simulated_trades.csv` for design/tuning.

CLI: `npm run eval:historical -- --fixture` or `--from-json path.json`  
Optional: `EVAL_MIN_PRIMARY_BARS=40` only when intentionally testing short series.

## Intentionally unchanged

- Legacy scoring / signal determination source
- Regime classifier; TREND / BREAKOUT / RANGE
- ML thresholds; setup thresholds
- Exits / sizing as strategy redesign
- Production default remains **legacy**
- `simulated_trades.csv`
