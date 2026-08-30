# Historical Evaluation Harness

**Purpose:** Measure the current independent regime/setup strategy against the frozen legacy strategy on identical, chronological historical OHLCV data.

**This module is evaluation infrastructure only.** It does **not** establish that the regime strategy is profitable or superior. No strategy parameters were optimized against evaluation data in this work.

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

Validation rejects (does **not** silently sort or dedupe):

- Empty input
- Missing / non-finite fields
- Invalid OHLC relationships
- Duplicate timestamps
- Out-of-order timestamps

Successful validation returns a **copy of the chronological input sequence**.

## Assumptions (identical for both engines)

| Topic | Convention |
|-------|------------|
| Entry timing | Signal on candle **T** enters at **T close** (matches live `closes.at(-1)`). |
| Slippage | Adverse on entry and exit; **P&L and R use executed prices only**. |
| Fees | Applied to realized P&L after executed-price calculation. |
| Look-ahead | Decision at T uses only candles `0..T`. |
| Warm-up | No decisions until `minPrimaryBars` (default 300). HTF needs `minHtfBars` (default 50). |
| Resolution | Subsequent bars of the **same** series; `maxHoldBars` (default 10). |
| Same-bar TP/SL | **partial TP → full TP → SL**. |
| Overlapping positions | **Independent**. |
| End of data | Timeout at last bar midpoint; incomplete if no post-entry bars. |
| ML on legacy | Stub `isReady()=false`. |
| Order book | Stub imbalance **0**. |

## Fresh evaluation data

1. Supply chronological `HistoricalCandle[]`.
2. Filter to the evaluation range before calling the harness if needed.
3. Result `manifest` records symbol, timeframe, range, count, content hash.
4. **Do not** use `simulated_trades.csv` for design/tuning.

```ts
import { runHistoricalComparison } from '../src/lib/evaluation';
const result = await runHistoricalComparison({
  candles: myUnseenOhlcv,
  manifestLabel: 'BTCUSDT-3m-2024H2',
});
```

CLI: `npm run eval:historical -- --fixture` or `--from-json path.json`

## Intentionally unchanged

- Legacy scoring / signal determination
- Regime classifier thresholds
- TREND / BREAKOUT / RANGE setup rules
- ML behavior and thresholds
- Exits as a strategy improvement
- Position sizing
- Production default (`STRATEGY_ENGINE` default remains **legacy**)
- `simulated_trades.csv`

## Known limitations

- Outcome resolution uses the decision timeframe series, not a separate 1m path.
- HTF without a separate series is a coarse aggregate of primary bars.
- No order-book history.
- No claim of profitability from smoke tests.
