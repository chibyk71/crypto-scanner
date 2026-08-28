# Phase 0 — Baseline reports

This directory holds **reproducible baseline snapshots** of current strategy performance.

## Generate

Against production MySQL:

```bash
DATABASE_URL=mysql://user:pass@host:3306/crypto_scanner \
  npm run baseline:report
```

From a full JSON export of `simulated_trades` (storage units):

```bash
npm run baseline:report -- --from-json path/to/export.json
```

Outputs:

| File | Purpose |
|------|---------|
| `BASELINE_REPORT.md` | Human-readable full report |
| `BASELINE_REPORT.json` | Structured report (all sections) |
| `BASELINE_REFERENCE.json` | Compact regression targets for later phases |

## Rules

- **Measurement only.** Running the report never changes strategy logic, thresholds, or execution.
- Reports are **immutable regression targets**. Do not overwrite a committed baseline after a strategy change; generate a new dated comparison instead.
- Always record git SHA + data cutoff in the report header.

## Drawdown methodology (frozen)

- Order by `closedAt` ascending (tie-break `id`)
- Starting equity: 0 R
- Open trades excluded
- Simultaneous closes treated as independent sequential R adds
- Max DD = maximum peak-to-trough decline of cumulative realized R
