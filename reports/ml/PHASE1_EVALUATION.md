# Phase 1 — Measurement & ML Validation Report

Generated: `2026-08-28T21:02:30Z`
Data source: `synthetic_fixture`
Result kind: **fixture_only**
Fixture: **True** | Seed: `42`

> **Not strategy evidence.** Re-run `python evaluate.py` with `training_export.csv` for real-data metrics.

## Dataset

- Samples: **200**
- Features: **33**
- Symbols: `['SYN']`
- Sides: `{'buy': 100, 'sell': 100}`
- Chronologically sorted: **True**
- Time range: `2023-11-14T22:13:20Z` → `2023-11-15T01:32:20Z`

### Native label counts (-2..+2)

| native | count |
|-------:|------:|
| -2 | 50 |
| -1 | 79 |
| +0 | 6 |
| +1 | 43 |
| +2 | 22 |

### Five-class (mapped) distribution

| class | count | proportion |
|-------|------:|-----------:|
| disaster | 50 | 0.250 |
| loss | 79 | 0.395 |
| neutral | 6 | 0.030 |
| good | 43 | 0.215 |
| monster | 22 | 0.110 |

## Chronological split (60 / 20 / 20)

- **train**: n=120
- **validation**: n=40
- **test**: n=40

## Information conditions

Pure ML-only cannot be isolated as a feature subset. Production ML consumes all 33 features (technical + history + identity) and emits label/confidence. None of the 33 features is an ML model output. Production Technical+ML is score-level fusion (buyScore/sellScore + ML bonus) which is not stored in the training CSV. Closest valid comparison: **technical_only** vs **full_feature_ml** (production ML inputs).

- **Technical-only** (`technical_only`): Feature indices 0–26
- **Production ML feature set (NOT pure ML-only)** (`full_feature_ml`): All 33 features

## Label mappings

- **five_class**: native -2..+2 → internal 0..4
- **four_class**: disaster=-2→0, loss=-1→1, neutral=0→2, win=+1|+2→3
- **three_class**: loss=-2|-1→0, neutral=0→1, win=+1|+2→2

## Fixture TEST summary (five_class)

| condition | accuracy | balanced_acc | macro_f1 |
|-----------|----------|--------------|----------|
| technical_only | 1.000 | 1.000 | 0.800 |
| full_feature_ml | 1.000 | 1.000 | 0.800 |

Synthetic data is linearly separable by design — perfect accuracy is expected and is **not** evidence of strategy edge.

## Leakage audit

- Export DESC by closed_at; evaluation sorts ASC (stable mergesort)
- Split 60/20/20; fit only on train; test never used for selection
- No scaler on full data; fixed hyperparameters (seed=42)
- Production train.py unchanged (full-dataset ONNX)

## Conclusions

- Primary evaluation is chronological; final test was unseen during fitting.
- Pure ML-only feature subset is not supported by the architecture.
- Severe class imbalance (neutral) is quantified; raw accuracy alone is insufficient.
- Fixture results must not be used as strategy evidence.

---
Phase 1 only — no strategy, entry, exit, or production ML gating changes.

Full JSON: run `python evaluate.py --fixture` → `reports/ml/PHASE1_EVALUATION.json`
