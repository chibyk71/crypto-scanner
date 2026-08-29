# Explicit Setup & Entry Hypotheses (Phase 3)

**Data independence:** These rules were **not** discovered, selected, or tuned
against `simulated_trades.csv` or any historical trade-outcome dataset.
They are structural / causal hypotheses for subsequent fresh-data evaluation.

**Frozen:** Legacy scoring, ML, historical-edge, sizing, and exits are unchanged.

---

## Pipeline

```text
Market context (indicators at decision candle)
    → Regime classification (TREND | RANGE | BREAKOUT)
    → Setup qualification
    → Entry trigger
    → Invalidation check
    → Trade decision (side) or HOLD
```

`detected === true` only when setup is qualified **and** entry is triggered
**and** the setup is not invalidated.

---

## TREND — continuation / pullback

### Market context
- `regime === TREND` and `isTrendEvidence` (ADX + DI separation + EMA stack).
- Direction must be consistent: bullish EMA stack **and** `trendBias === 'bullish'`
  (or the bearish pair). Contradictory alignment → no trade.

### Setup qualification (pullback)
- Within a fixed short lookback (5 bars, structural constant — not optimized):
  - **Long:** at least one bar’s low traded at/below `emaShort`, while lows
    stayed above `emaMid` (structure held).
  - **Short:** at least one bar’s high traded at/above `emaShort`, while highs
    stayed below `emaMid`.

### Entry trigger (continuation)
- **Long:** decision close reclaims above `emaShort` **and** MACD histogram
  is rising vs the previous closed bar.
- **Short:** decision close rejects below `emaShort` **and** MACD histogram
  is falling vs the previous closed bar.

### Invalidation
- **Long:** decision price below `emaMid` (mid-trend structure broken).
- **Short:** decision price above `emaMid`.

### Direction
- Long → `buy` / `trend_continuation_long`
- Short → `sell` / `trend_continuation_short`

### Why defensible
Pullback-into-fast-MA then continuation is a standard trend-following
structure. EMA mid as invalidation is a clear structure break. MACD histogram
turn is a simple causal momentum confirmation available at the decision candle.

### Intentionally NOT used
Outcome-derived thresholds, legacy score components, ML scores, future bars,
excursion statistics, `simulated_trades.csv` optimization.

---

## BREAKOUT — structural break + independent confirmation

### Market context
- `regime === BREAKOUT` routes to this detector.
- Structural context: `breakoutStructure` + `breakoutDirection` from the
  existing causal BB-squeeze detector (compression + expansion + directional
  break of the **prior** candle’s bands).

### Setup qualification
- Structural break present and direction is `bullish` or `bearish`.
- Decision close still outside the broken prior band.
- Not invalidated (see below).

### Entry trigger (confirmation beyond the regime label)
Regime `BREAKOUT` already implies classifier volume + structure. Entry still
requires **explicit, inspectable** confirmation:

1. `volumeConfirmed === true` (auditable, not implicit)
2. **MACD histogram agrees with direction** (rising & positive for long;
   falling & negative for short) — this condition is **not** part of
   `classifyRegime`’s `isBreakout` definition, so entry is not merely
   `regime === BREAKOUT`.

### Invalidation
- Close back through BB middle (failed break), or
- Close no longer outside the broken prior band.

### Direction
- Bullish → `buy` / `breakout_long`
- Bearish → `sell` / `breakout_short`

### Why defensible
Separates “market is in a breakout state” from “confirmation justifies entry.”
MACD agreement is an independent causal filter available at decision time.

### Intentionally NOT used
Future bars to “confirm” a past break, outcome-based parameter search,
legacy scoring points, ATR-only “breakouts” without structure.

---

## RANGE — NO_TRADE

### Status
**Explicitly no entry** in this phase.

### Why
A defensible mean-reversion setup needs reliable range boundaries (e.g. accepted
swing edges or value-area structure) and a rejection trigger at those edges.
BB/VWAP location alone is not treated here as a complete entry specification.

### What is recorded
Range diagnostics (`isRangeEvidence`, ADX/DI weakness, EMA neutrality, near VWAP)
for audit. `side` is always `null`.

### Intentionally deferred
Evidence-backed range boundary model and rejection rules (later phase).

---

## Causality

All conditions use:

- Decision-candle values, and/or
- Previously closed bars in indicator series already computed for the candidate

No future candles, future highs/lows, future regime labels, or trade outcomes
are referenced.

---

## Deferred (later phases)

- Fresh-data simulation and expectancy comparison vs legacy
- RANGE mean-reversion design
- Exit redesign
- Position sizing
- Historical edge gating
- ML quality filter
- Hybrid engine
