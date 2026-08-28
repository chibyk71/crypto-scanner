# Phase 0 — Baseline reports

This directory holds **reproducible baseline snapshots** of current strategy performance.

## Metric definitions (frozen)

| Term | Definition |
|------|------------|
| **Winning trade** | `outcome` is `tp` or `partial_tp` |
| **R** | Realized risk-multiple: `r_multiple / 1e4` from DB storage |
| **Profit factor** | `sum(R>0) / abs(sum(R<0))`; `null` if no losses |
| **Max drawdown** | Max peak-to-trough decline of cumulative realized R, ordered by `closedAt` ASC (tie-break `id`), start equity 0 R, open trades excluded |
| **MFE** | Max favorable excursion as % of entry (`mfe / 1e4`) |
| **MAE** | Max adverse excursion as % of entry (`mae / 1e4`) |
| **Holding time** | `duration_ms` from entry to close |
| **Confidence buckets** | `0-20`, `21-40`, `41-60`, `61-80`, `81-100`, `unknown` |
| **Holding-time buckets** | `<5 min`, `5-15 min`, `15-30 min`, `30-60 min`, `1-2 h`, `2-4 h`, `4-8 h`, `>=8 h` |
| **Regime categories** | Values stored on `simulated_trades.regime` at entry (`strong_trend`, `weak_trend`, `ranging`, `high_volatility`, `choppy`, or `unknown` if null) |
| **ML labels** | Integer `-2..+2` on `label` (outcome-derived); `ml_predicted_label` is model prediction at signal time |
| **Completed set** | `closedAt IS NOT NULL` AND `outcome IS NOT NULL` |
| **Low-sample** | Group with n < 30 (symbols/regimes); marked, not dropped |

## Generate (production)

```bash
DATABASE_URL=mysql://user:pass@host:3306/crypto_scanner \
  npm run baseline:report
```

From a full JSON export of `simulated_trades` (storage units):

```bash
npm run baseline:report -- --from-json path/to/export.json
```

Offline pipeline check (synthetic data — **not** the production baseline):

```bash
npm run baseline:fixture
```

## Outputs

| File | Purpose |
|------|---------|
| `BASELINE_REPORT.md` | Human-readable full report |
| `BASELINE_REPORT.json` | Structured report (all sections) |
| `BASELINE_REFERENCE.json` | Compact regression targets for later phases |

Fixture runs write `*.fixture.*` filenames so they cannot overwrite a live baseline.

## Rules

- **Measurement only.** Running the report never changes strategy logic, thresholds, or execution.
- Reports are **immutable regression targets**. Do not overwrite a committed production baseline after a strategy change; generate a new dated comparison instead.
- Always record git SHA + data cutoff in the report header.
- Do not invent missing fields. If a field is null in the DB, it is audited and metrics that require it skip those rows only where mathematically necessary.
