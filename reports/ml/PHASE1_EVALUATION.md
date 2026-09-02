# Phase 1 — Measurement & ML Validation Report

Generated: `2026-09-02T02:37:01Z`
Data source: `C:\Users\user\Documents\projects\crypto-scanner\ml\data\simulated_trades.csv`
Result kind: **real_training_export**
Fixture: **False** | Seed: `42`

## Dataset

- Samples: **3876**
- Features: **33**
- Symbols: `['AAVE/USDT', 'ADA/USDT', 'ALGO/USDT', 'APT/USDT', 'ARB/USDT', 'AVAX/USDT', 'BCH/USDT', 'BNB/USDT', 'BTC/USDT', 'DOGE/USDT', 'DOT/USDT', 'ENA/USDT', 'ETH/USDT', 'FIL/USDT', 'ICP/USDT', 'INJ/USDT', 'LINK/USDT', 'LTC/USDT', 'NEAR/USDT', 'NOT/USDT', 'OP/USDT', 'PEPE/USDT', 'SOL/USDT', 'STX/USDT', 'SUI/USDT', 'TRX/USDT', 'UNI/USDT', 'WLD/USDT', 'XAUT/USDT', 'XRP/USDT']`
- Sides: `{'buy': 2063, 'sell': 1813}`
- Chronologically sorted: **True**
- Time range: `2026-08-19T06:29:21Z` → `2026-09-02T02:08:03Z`

### Native label counts (-2..+2)

| native | count |
|-------:|------:|
| -2 | 1535 |
| -1 | 576 |
| +0 | 32 |
| +1 | 1195 |
| +2 | 538 |

### Five-class (mapped) distribution

| class | count | proportion |
|-------|------:|-----------:|
| disaster | 1535 | 0.396 |
| loss | 576 | 0.149 |
| neutral | 32 | 0.008 |
| good | 1195 | 0.308 |
| monster | 538 | 0.139 |

## Chronological split (60 / 20 / 20)

- **train**: n=2325, `2026-08-19T06:29:21Z` → `2026-08-25T14:01:48Z`
- **validation**: n=775, `2026-08-25T14:01:49Z` → `2026-08-28T17:04:48Z`
- **test**: n=776, `2026-08-28T17:14:44Z` → `2026-09-02T02:08:03Z`
- Boundary ties: `{'train_val_boundary_same_ts': 0, 'val_test_boundary_same_ts': 0, 'note': 'If 1, last train and first val (or val/test) share closed_at. Rows are non-overlapping by index; same-ms events may be concurrent.'}`

## Partition design

Phase 1 is a fixed-model diagnostic. TRAIN (60%) is used only for fitting. VALIDATION (20%) is reported for diagnostics only and is not used for model/formulation/hyperparameter selection. FINAL TEST (20%) is untouched until final evidence reporting. All formulations and information conditions are reported independently; no winner is selected from validation or test for configuration choice.

## Information conditions

Pure ML-only cannot be isolated as a feature subset. Production ML consumes all 33 features and emits label/confidence. None of the 33 features is an ML model output. Production buyScore/sellScore + ML bonus fusion is score-level and is not stored in the training CSV. Closest valid comparison: signal_subset_0_26 (report key technical_only) vs full_feature_ml (all 33 production ML inputs). signal_subset_0_26 is a measurement baseline, not a replay of production technical scores.

- **Signal-input subset 0–26 (measurement baseline; not production score)** (`technical_only`): 27-feature signal-input subset (indices 0–26): contemporaneous indicators, excursion-history MFE/MAE/ratios, market context, pattern flags. Measurement baseline only — NOT a replay of production buyScore/sellScore (those score-level values are not in the training export).
- **Full production ML input vector (33 features; not ML-only)** (`full_feature_ml`): All 33 production ML input features matching mlService.extractFeatures(). NOT pure ML-only — includes the signal-input subset plus prev-sim outcomes and symbol_index.

## Label mappings

- **five_class**: native -2..+2 → internal 0..4 (repository default)
- **four_class**: disaster=-2→0, loss=-1→1, neutral=0→2, win=+1|+2→3
- **three_class**: loss=-2|-1→0, neutral=0→1, win=+1|+2→2

## Leakage audit (process)

- Export ordered DESC by closed_at; evaluation sorts ASC (stable mergesort).
- Split 60/20/20 chronological; model.fit uses only train indices.
- Final test never used for fit or selection (no selection step in Phase 1).
- Validation is diagnostic only — not used for formulation/config selection.
- No scaler/imputer fitted on full data; features pre-normalized at export.
- Hyperparameters fixed (EVAL_XGB_PARAMS, seed=42); not tuned on test.
- Production train.py still fits full dataset for ONNX; unchanged.
- Equal closed_at: stable order; boundary_ties recorded if partition edge shares ms.

## Model configuration (evaluation artifacts only)

```json
{
  "n_estimators": 150,
  "max_depth": 5,
  "learning_rate": 0.05,
  "subsample": 0.8,
  "colsample_bytree": 0.8,
  "min_child_weight": 3,
  "gamma": 0.1,
  "objective": "multi:softprob",
  "eval_metric": "mlogloss",
  "random_state": 42,
  "n_jobs": 1
}
```

> These models are **not** production ONNX exports. `train.py` remains the production training entrypoint.

## Results

VALIDATION metrics are diagnostic only (not used for selection). FINAL TEST is untouched evidence. All formulations × conditions are reported independently — no winner is selected.

## five_class / technical_only (27 features) — Signal-input subset 0–26 (measurement baseline; not production score)

Train counts: `{0: 865, 1: 314, 2: 23, 3: 779, 4: 344}`  
Val counts: `{0: 308, 1: 148, 2: 1, 3: 212, 4: 106}`  
Test counts: `{0: 362, 1: 114, 2: 8, 3: 204, 4: 88}`

### VALIDATION — five_class / technical_only (27 features) — Signal-input subset 0–26 (measurement baseline; not production score)

- n = 775
- accuracy = 0.3497
- balanced_accuracy = 0.2065
- macro_f1 = 0.1854
- unreliable classes (support < 10): [2]

| class | support | precision | recall | f1 | predicted |
|-------|--------:|----------:|-------:|---:|----------:|
| disaster | 308 | 0.392 | 0.617 | 0.479 | 485 |
| loss | 148 | 0.200 | 0.034 | 0.058 | 25 |
| neutral * | 1 | 0.000 | 0.000 | 0.000 | 0 |
| good | 212 | 0.282 | 0.335 | 0.306 | 252 |
| monster | 106 | 0.385 | 0.047 | 0.084 | 13 |

Confusion matrix (rows=actual, cols=predicted):

| actual \ pred | 0 | 1 | 2 | 3 | 4 |
|---|---|---|---|---|---|
| disaster | 190 | 6 | 0 | 108 | 4 |
| loss | 99 | 5 | 0 | 41 | 3 |
| neutral | 0 | 0 | 0 | 1 | 0 |
| good | 129 | 11 | 0 | 71 | 1 |
| monster | 67 | 3 | 0 | 31 | 5 |

### TEST — five_class / technical_only (27 features) — Signal-input subset 0–26 (measurement baseline; not production score)

- n = 776
- accuracy = 0.4034
- balanced_accuracy = 0.2230
- macro_f1 = 0.2111
- unreliable classes (support < 10): [2]

| class | support | precision | recall | f1 | predicted |
|-------|--------:|----------:|-------:|---:|----------:|
| disaster | 362 | 0.479 | 0.613 | 0.538 | 463 |
| loss | 114 | 0.256 | 0.096 | 0.140 | 43 |
| neutral * | 8 | 0.000 | 0.000 | 0.000 | 0 |
| good | 204 | 0.301 | 0.382 | 0.337 | 259 |
| monster | 88 | 0.182 | 0.023 | 0.040 | 11 |

Confusion matrix (rows=actual, cols=predicted):

| actual \ pred | 0 | 1 | 2 | 3 | 4 |
|---|---|---|---|---|---|
| disaster | 222 | 18 | 0 | 118 | 4 |
| loss | 73 | 11 | 0 | 30 | 0 |
| neutral | 6 | 1 | 0 | 1 | 0 |
| good | 112 | 9 | 0 | 78 | 5 |
| monster | 50 | 4 | 0 | 32 | 2 |

## five_class / full_feature_ml (33 features) — Full production ML input vector (33 features; not ML-only)

Train counts: `{0: 865, 1: 314, 2: 23, 3: 779, 4: 344}`  
Val counts: `{0: 308, 1: 148, 2: 1, 3: 212, 4: 106}`  
Test counts: `{0: 362, 1: 114, 2: 8, 3: 204, 4: 88}`

### VALIDATION — five_class / full_feature_ml (33 features) — Full production ML input vector (33 features; not ML-only)

- n = 775
- accuracy = 0.3626
- balanced_accuracy = 0.2182
- macro_f1 = 0.1990
- unreliable classes (support < 10): [2]

| class | support | precision | recall | f1 | predicted |
|-------|--------:|----------:|-------:|---:|----------:|
| disaster | 308 | 0.400 | 0.607 | 0.483 | 467 |
| loss | 148 | 0.188 | 0.041 | 0.067 | 32 |
| neutral * | 1 | 0.000 | 0.000 | 0.000 | 0 |
| good | 212 | 0.313 | 0.387 | 0.346 | 262 |
| monster | 106 | 0.429 | 0.057 | 0.100 | 14 |

Confusion matrix (rows=actual, cols=predicted):

| actual \ pred | 0 | 1 | 2 | 3 | 4 |
|---|---|---|---|---|---|
| disaster | 187 | 9 | 0 | 109 | 3 |
| loss | 93 | 6 | 0 | 45 | 4 |
| neutral | 0 | 0 | 0 | 1 | 0 |
| good | 117 | 12 | 0 | 82 | 1 |
| monster | 70 | 5 | 0 | 25 | 6 |

### TEST — five_class / full_feature_ml (33 features) — Full production ML input vector (33 features; not ML-only)

- n = 776
- accuracy = 0.3969
- balanced_accuracy = 0.2209
- macro_f1 = 0.2110
- unreliable classes (support < 10): [2]

| class | support | precision | recall | f1 | predicted |
|-------|--------:|----------:|-------:|---:|----------:|
| disaster | 362 | 0.471 | 0.605 | 0.530 | 465 |
| loss | 114 | 0.271 | 0.114 | 0.160 | 48 |
| neutral * | 8 | 0.000 | 0.000 | 0.000 | 0 |
| good | 204 | 0.292 | 0.363 | 0.324 | 253 |
| monster | 88 | 0.200 | 0.023 | 0.041 | 10 |

Confusion matrix (rows=actual, cols=predicted):

| actual \ pred | 0 | 1 | 2 | 3 | 4 |
|---|---|---|---|---|---|
| disaster | 219 | 17 | 0 | 123 | 3 |
| loss | 74 | 13 | 0 | 26 | 1 |
| neutral | 7 | 0 | 0 | 1 | 0 |
| good | 114 | 12 | 0 | 74 | 4 |
| monster | 51 | 6 | 0 | 29 | 2 |

## four_class / technical_only (27 features) — Signal-input subset 0–26 (measurement baseline; not production score)

Train counts: `{0: 865, 1: 314, 2: 23, 3: 1123}`  
Val counts: `{0: 308, 1: 148, 2: 1, 3: 318}`  
Test counts: `{0: 362, 1: 114, 2: 8, 3: 292}`

### VALIDATION — four_class / technical_only (27 features) — Signal-input subset 0–26 (measurement baseline; not production score)

- n = 775
- accuracy = 0.4232
- balanced_accuracy = 0.2645
- macro_f1 = 0.2417
- unreliable classes (support < 10): [2]

| class | support | precision | recall | f1 | predicted |
|-------|--------:|----------:|-------:|---:|----------:|
| disaster | 308 | 0.410 | 0.383 | 0.396 | 288 |
| loss | 148 | 0.250 | 0.027 | 0.049 | 16 |
| neutral * | 1 | 0.000 | 0.000 | 0.000 | 0 |
| win | 318 | 0.437 | 0.648 | 0.522 | 471 |

Confusion matrix (rows=actual, cols=predicted):

| actual \ pred | 0 | 1 | 2 | 3 |
|---|---|---|---|---|
| disaster | 118 | 6 | 0 | 184 |
| loss | 64 | 4 | 0 | 80 |
| neutral | 0 | 0 | 0 | 1 |
| win | 106 | 6 | 0 | 206 |

### TEST — four_class / technical_only (27 features) — Signal-input subset 0–26 (measurement baseline; not production score)

- n = 776
- accuracy = 0.4420
- balanced_accuracy = 0.2810
- macro_f1 = 0.2724
- unreliable classes (support < 10): [2]

| class | support | precision | recall | f1 | predicted |
|-------|--------:|----------:|-------:|---:|----------:|
| disaster | 362 | 0.495 | 0.434 | 0.462 | 317 |
| loss | 114 | 0.333 | 0.088 | 0.139 | 30 |
| neutral * | 8 | 0.000 | 0.000 | 0.000 | 0 |
| win | 292 | 0.410 | 0.603 | 0.488 | 429 |

Confusion matrix (rows=actual, cols=predicted):

| actual \ pred | 0 | 1 | 2 | 3 |
|---|---|---|---|---|
| disaster | 157 | 9 | 0 | 196 |
| loss | 52 | 10 | 0 | 52 |
| neutral | 2 | 1 | 0 | 5 |
| win | 106 | 10 | 0 | 176 |

## four_class / full_feature_ml (33 features) — Full production ML input vector (33 features; not ML-only)

Train counts: `{0: 865, 1: 314, 2: 23, 3: 1123}`  
Val counts: `{0: 308, 1: 148, 2: 1, 3: 318}`  
Test counts: `{0: 362, 1: 114, 2: 8, 3: 292}`

### VALIDATION — four_class / full_feature_ml (33 features) — Full production ML input vector (33 features; not ML-only)

- n = 775
- accuracy = 0.4168
- balanced_accuracy = 0.2630
- macro_f1 = 0.2440
- unreliable classes (support < 10): [2]

| class | support | precision | recall | f1 | predicted |
|-------|--------:|----------:|-------:|---:|----------:|
| disaster | 308 | 0.416 | 0.347 | 0.379 | 257 |
| loss | 148 | 0.241 | 0.047 | 0.079 | 29 |
| neutral * | 1 | 0.000 | 0.000 | 0.000 | 0 |
| win | 318 | 0.427 | 0.657 | 0.518 | 489 |

Confusion matrix (rows=actual, cols=predicted):

| actual \ pred | 0 | 1 | 2 | 3 |
|---|---|---|---|---|
| disaster | 107 | 11 | 0 | 190 |
| loss | 52 | 7 | 0 | 89 |
| neutral | 0 | 0 | 0 | 1 |
| win | 98 | 11 | 0 | 209 |

### TEST — four_class / full_feature_ml (33 features) — Full production ML input vector (33 features; not ML-only)

- n = 776
- accuracy = 0.4356
- balanced_accuracy = 0.2796
- macro_f1 = 0.2702
- unreliable classes (support < 10): [2]

| class | support | precision | recall | f1 | predicted |
|-------|--------:|----------:|-------:|---:|----------:|
| disaster | 362 | 0.507 | 0.409 | 0.453 | 292 |
| loss | 114 | 0.244 | 0.096 | 0.138 | 45 |
| neutral * | 8 | 0.000 | 0.000 | 0.000 | 0 |
| win | 292 | 0.408 | 0.613 | 0.490 | 439 |

Confusion matrix (rows=actual, cols=predicted):

| actual \ pred | 0 | 1 | 2 | 3 |
|---|---|---|---|---|
| disaster | 148 | 16 | 0 | 198 |
| loss | 43 | 11 | 0 | 60 |
| neutral | 5 | 1 | 0 | 2 |
| win | 96 | 17 | 0 | 179 |

## three_class / technical_only (27 features) — Signal-input subset 0–26 (measurement baseline; not production score)

Train counts: `{0: 1179, 1: 23, 2: 1123}`  
Val counts: `{0: 456, 1: 1, 2: 318}`  
Test counts: `{0: 476, 1: 8, 2: 292}`

### VALIDATION — three_class / technical_only (27 features) — Signal-input subset 0–26 (measurement baseline; not production score)

- n = 775
- accuracy = 0.5600
- balanced_accuracy = 0.3556
- macro_f1 = 0.3544
- unreliable classes (support < 10): [1]

| class | support | precision | recall | f1 | predicted |
|-------|--------:|----------:|-------:|---:|----------:|
| loss | 456 | 0.614 | 0.686 | 0.648 | 510 |
| neutral * | 1 | 0.000 | 0.000 | 0.000 | 0 |
| win | 318 | 0.457 | 0.381 | 0.415 | 265 |

Confusion matrix (rows=actual, cols=predicted):

| actual \ pred | 0 | 1 | 2 |
|---|---|---|---|
| loss | 313 | 0 | 143 |
| neutral | 0 | 0 | 1 |
| win | 197 | 0 | 121 |

### TEST — three_class / technical_only (27 features) — Signal-input subset 0–26 (measurement baseline; not production score)

- n = 776
- accuracy = 0.6044
- balanced_accuracy = 0.3734
- macro_f1 = 0.3702
- unreliable classes (support < 10): [1]

| class | support | precision | recall | f1 | predicted |
|-------|--------:|----------:|-------:|---:|----------:|
| loss | 476 | 0.650 | 0.771 | 0.705 | 565 |
| neutral * | 8 | 0.000 | 0.000 | 0.000 | 0 |
| win | 292 | 0.483 | 0.349 | 0.406 | 211 |

Confusion matrix (rows=actual, cols=predicted):

| actual \ pred | 0 | 1 | 2 |
|---|---|---|---|
| loss | 367 | 0 | 109 |
| neutral | 8 | 0 | 0 |
| win | 190 | 0 | 102 |

## three_class / full_feature_ml (33 features) — Full production ML input vector (33 features; not ML-only)

Train counts: `{0: 1179, 1: 23, 2: 1123}`  
Val counts: `{0: 456, 1: 1, 2: 318}`  
Test counts: `{0: 476, 1: 8, 2: 292}`

### VALIDATION — three_class / full_feature_ml (33 features) — Full production ML input vector (33 features; not ML-only)

- n = 775
- accuracy = 0.5484
- balanced_accuracy = 0.3475
- macro_f1 = 0.3459
- unreliable classes (support < 10): [1]

| class | support | precision | recall | f1 | predicted |
|-------|--------:|----------:|-------:|---:|----------:|
| loss | 456 | 0.605 | 0.678 | 0.639 | 511 |
| neutral * | 1 | 0.000 | 0.000 | 0.000 | 0 |
| win | 318 | 0.439 | 0.365 | 0.399 | 264 |

Confusion matrix (rows=actual, cols=predicted):

| actual \ pred | 0 | 1 | 2 |
|---|---|---|---|
| loss | 309 | 0 | 147 |
| neutral | 0 | 0 | 1 |
| win | 202 | 0 | 116 |

### TEST — three_class / full_feature_ml (33 features) — Full production ML input vector (33 features; not ML-only)

- n = 776
- accuracy = 0.6057
- balanced_accuracy = 0.3759
- macro_f1 = 0.3732
- unreliable classes (support < 10): [1]

| class | support | precision | recall | f1 | predicted |
|-------|--------:|----------:|-------:|---:|----------:|
| loss | 476 | 0.652 | 0.765 | 0.704 | 558 |
| neutral * | 8 | 0.000 | 0.000 | 0.000 | 0 |
| win | 292 | 0.486 | 0.363 | 0.416 | 218 |

Confusion matrix (rows=actual, cols=predicted):

| actual \ pred | 0 | 1 | 2 |
|---|---|---|---|
| loss | 364 | 0 | 112 |
| neutral | 8 | 0 | 0 |
| win | 186 | 0 | 106 |

## Limitations

- Pure ML-only cannot be isolated as a feature subset. Production ML consumes all 33 features and emits label/confidence. None of the 33 features is an ML model output. Production buyScore/sellScore + ML bonus fusion is score-level and is not stored in the training CSV. Closest valid comparison: signal_subset_0_26 (report key technical_only) vs full_feature_ml (all 33 production ML inputs). signal_subset_0_26 is a measurement baseline, not a replay of production technical scores.
- five_class/technical_only/validation: missing=[] unreliable=[2]
- five_class/technical_only/test: missing=[] unreliable=[2]
- five_class/full_feature_ml/validation: missing=[] unreliable=[2]
- five_class/full_feature_ml/test: missing=[] unreliable=[2]
- four_class/technical_only/validation: missing=[] unreliable=[2]
- four_class/technical_only/test: missing=[] unreliable=[2]
- four_class/full_feature_ml/validation: missing=[] unreliable=[2]
- four_class/full_feature_ml/test: missing=[] unreliable=[2]
- three_class/technical_only/validation: missing=[] unreliable=[1]
- three_class/technical_only/test: missing=[] unreliable=[1]
- three_class/full_feature_ml/validation: missing=[] unreliable=[1]
- three_class/full_feature_ml/test: missing=[] unreliable=[1]

## Conclusions

- Phase 1 is a fixed-model diagnostic. TRAIN (60%) is used only for fitting. VALIDATION (20%) is reported for diagnostics only and is not used for model/formulation/hyperparameter selection. FINAL TEST (20%) is untouched until final evidence reporting. All formulations and information conditions are reported independently; no winner is selected from validation or test for configuration choice.
- Primary evaluation is chronological; final test was unseen during fitting and was not used for any selection decision.
- Pure ML-only feature subset is not supported by the architecture; see ml_only_limitation.
- Severe class imbalance (especially neutral) is quantified; raw accuracy alone is insufficient.
- signal_subset_0_26 (report key technical_only) is a 27-feature measurement baseline, not a replay of production buyScore/sellScore.
- Five-class FINAL TEST (independent report, not a selection): signal_subset_0_26 macro_f1=0.2111 balanced_acc=0.2230; full_feature_ml macro_f1=0.2110 balanced_acc=0.2209.
- No formulation or information condition is declared the winner on the basis of FINAL TEST; all cells are reported for inspection.

---
Phase 1 only — no strategy, entry, exit, or production ML gating changes.
