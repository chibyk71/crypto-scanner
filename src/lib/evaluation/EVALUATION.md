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
| ML | `StubMLService.isReady() === false` → production **ML-unavailable** branch: **no** prediction bonus/penalty **and** technical buy/sell scores × `ML_CONFIDENCE_DISCOUNT` (0.8). Same as production when no ONNX model is loaded. |
| Order book | `StubExchangeService` imbalance **0** → **no** book points (same as unavailable book or `|imbalance|` below threshold) |
| Technical scoring / signal / risk | **Unmodified** legacy source |

**Why not live ML + book?** Causal ML features cannot be reconstructed from OHLCV alone (`extractFeatures` uses excursion history cache and wall-clock time). Live order-book imbalance is not present in historical OHLCV. Preferring a true causal control over a contaminated "production ML" replay is intentional.

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

## HTF convention

**Production config** (`src/lib/config/settings.ts`):

| Setting | Default |
|---------|---------|
| `TIMEFRAME` (primary) | `3m` |
| `HTF_TIMEFRAME` | `15m` |

Live scanner fetches primary and HTF as **separate** exchange series (`scanner.ts` → `getHtfData`).

**Harness behavior:**

1. If a separate HTF series is supplied → use it causally (`htf.timestamp <= decisionTs`). Manifest: `htfSource: 'provided_series'`.
2. If not → synthetic aggregate with **explicit** `htfAggregationRatio` (default **5** = 15m/3m). **Not** derived from `minPrimaryBars`. Manifest records ratio + timeframe labels.

`downsampleToHtf(primary[0..T], ratio)`:

- Emits only **complete** buckets of exactly `ratio` primary bars.
- Trailing incomplete primary bars are **omitted**.
- HTF timestamp = last primary bar in the bucket → always ≤ T.

## End-of-data / incomplete trades

| Case | Outcome |
|------|---------|
| TP/SL within available bars | completed (`tp` / `partial_tp` / `sl`) |
| Full `maxHoldBars` future bars observed, no TP/SL | genuine `timeout` |
| Dataset ends before full `maxHoldBars` future bars | **`incomplete`** (censored) |

Incomplete trades:

- Remain in `trades` for audit (last midpoint may be recorded).
- Are **excluded** from `metrics` / `baselineRows`.
- Counted in `incompleteCount`.

They are **never** coerced to `timeout` for performance metrics.

## Assumptions (identical for both engines)

| Topic | Convention |
|-------|------------|
| Entry timing | Signal on candle **T** enters at **T close**. |
| Slippage | Adverse on entry/exit; **P&L and R from executed prices only**. |
| Fees | After executed-price P&L. |
| Look-ahead | Decision at T uses only candles `0..T`. |
| Same-bar TP/SL | partial TP → full TP → SL. |
| Overlaps | Independent. |
| End of data | `timeout` only if full horizon available; else `incomplete`. |

## Fresh evaluation data

1. Supply chronological `HistoricalCandle[]` with **≥ 300** primary bars (or explicit warm-up override).
2. Optionally supply a separate HTF series with the production relationship (3m→15m).
3. Manifest records range, content hash, `legacyControlVariant`, HTF source/ratio.
4. **Do not** use `simulated_trades.csv` for design/tuning.

CLI: `npm run eval:historical -- --fixture` or `--from-json path.json`  
Optional: `EVAL_MIN_PRIMARY_BARS=40` only when intentionally testing short series.

## Intentionally unchanged

- Legacy scoring / signal determination source
- Regime classifier; TREND / BREAKOUT / RANGE
- ML thresholds; setup thresholds
- Exits / sizing as strategy redesign
- Production default remains **legacy**
- `simulated_trades.csv`
