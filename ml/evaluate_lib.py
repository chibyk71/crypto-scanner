# ml/evaluate_lib.py
# Phase 1 — Chronological ML evaluation core (measurement only)
# Production train.py / ONNX / trading behavior are NOT changed.
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np
from xgboost import XGBClassifier

from chronological import (
    chronological_split,
    count_boundary_ties,
    time_range_summary,
    verify_no_future_leakage,
)
from labels import (
    ALL_FORMULATIONS,
    FORMULATION_FIVE,
    LabelFormulation,
    class_counts,
    class_proportions,
)
from metrics_report import metrics_to_markdown, safe_classification_metrics
from utils import (
    EXPECTED_FEATURES,
    FEATURE_NAMES,
    FULL_FEATURE_INDICES,
    TECHNICAL_FEATURE_INDICES,
    TrainingFrame,
    load_training_frame,
    select_feature_columns,
)

ML_DIR = Path(__file__).resolve().parent
REPO_ROOT = ML_DIR.parent
DEFAULT_DATA_CANDIDATES = [
    ML_DIR / "data" / "training_export.csv",
    ML_DIR / "data" / "simulated_trades.csv",
]
REPORT_DIR = REPO_ROOT / "reports" / "ml"
RANDOM_SEED = 42

EVAL_XGB_PARAMS = dict(
    n_estimators=150,
    max_depth=5,
    learning_rate=0.05,
    subsample=0.8,
    colsample_bytree=0.8,
    min_child_weight=3,
    gamma=0.1,
    objective="multi:softprob",
    eval_metric="mlogloss",
    random_state=RANDOM_SEED,
    n_jobs=1,
)

# =============================================================================
# Information conditions (measurement adapters — no production changes)
# =============================================================================
#
# Repository fact (mlService.extractFeatures):
#   ALL 33 features are extracted at SIGNAL time and fed into the ONNX model.
#   None of the 33 features is an ML model output. ML is the XGBoost/ONNX
#   inference engine, not a feature subset.
#
# Production path (computeScores):
#   1. buyScore/sellScore accumulate from indicators (not stored in the CSV)
#   2. ML predict(features) → label + confidence → bonus/penalty on scores
#
# Phase 1 measurement adapters (NOT a replay of production scores):
#   signal_subset_0_26  (key: "technical_only" kept for report continuity):
#       indices 0–26 — the 27-feature signal-input subset used as the
#       measurement baseline. Includes contemporaneous indicators, excursion-
#       history MFE/MAE/ratios, market context, and pattern flags.
#       This is NOT identical to production buyScore/sellScore calculation.
#
#   full_feature_ml:
#       indices 0–32 — all 33 production ML *input* features.
#       NOT "ML-only". Includes signal subset + prev-sim outcomes + identity.
#
# Pure ML-only cannot be isolated from the export CSV.
#
# Partition design (fixed-model diagnostic — no selection on validation):
#   TRAIN (60%)       → fit only
#   VALIDATION (20%)  → diagnostic metrics only (not used for selection)
#   FINAL TEST (20%)  → untouched final evidence
# All formulations × conditions are reported independently; no winner is
# chosen from validation or test for model/config selection in Phase 1.
# =============================================================================

INFORMATION_CONDITIONS = {
    "technical_only": {
        "indices": TECHNICAL_FEATURE_INDICES,
        "description": (
            "27-feature signal-input subset (indices 0–26): contemporaneous "
            "indicators, excursion-history MFE/MAE/ratios, market context, "
            "pattern flags. Measurement baseline only — NOT a replay of "
            "production buyScore/sellScore (those score-level values are not "
            "in the training export)."
        ),
        "role": "Signal-input subset 0–26 (measurement baseline; not production score)",
    },
    "full_feature_ml": {
        "indices": FULL_FEATURE_INDICES,
        "description": (
            "All 33 production ML input features matching "
            "mlService.extractFeatures(). NOT pure ML-only — includes the "
            "signal-input subset plus prev-sim outcomes and symbol_index."
        ),
        "role": "Full production ML input vector (33 features; not ML-only)",
    },
}


def leakage_audit_features() -> List[Dict[str, str]]:
    rows = []
    groups = [
        (range(0, 15), "technical indicators", "available_at_prediction",
         "Computed from candles at signal time in computeIndicators."),
        (range(15, 21), "excursion regime MFE/MAE", "available_at_prediction",
         "Historical aggregates from prior closed sims via excursionHistoryCache."),
        (range(21, 25), "market context", "available_at_prediction",
         "OBV/VWAP/volume from current candle window."),
        (range(25, 27), "pattern flags", "available_at_prediction",
         "Liquidity sweep / BB squeeze on current candle."),
        (range(27, 31), "prev sim outcome/label", "available_at_prediction",
         "Prior closed sim for same symbol. Not the current trade's outcome."),
        ([31], "time_since_last_sim", "available_at_prediction",
         "Elapsed since most recent prior sim; uses Date.now at extract time."),
        ([32], "symbol_index", "available_at_prediction",
         "Stable registry index; not outcome-derived."),
    ]
    for idxs, group, status, note in groups:
        for i in idxs:
            rows.append({
                "index": i,
                "name": FEATURE_NAMES[i],
                "group": group,
                "status": status,
                "note": note,
            })
    return rows


def _find_data_path(explicit: Optional[str]) -> Optional[Path]:
    if explicit:
        p = Path(explicit)
        return p if p.exists() else None
    for c in DEFAULT_DATA_CANDIDATES:
        if c.exists():
            return c
    return None


def make_synthetic_frame(n: int = 200, seed: int = RANDOM_SEED) -> TrainingFrame:
    rng = np.random.RandomState(seed)
    t0 = 1_700_000_000_000
    closed_at = t0 + np.arange(n, dtype=np.int64) * 60_000
    closed_at[10] = closed_at[9]
    closed_at[11] = closed_at[9]
    X = rng.randn(n, EXPECTED_FEATURES).astype(np.float32)
    logits = X[:, 0]
    y_native = np.full(n, -1, dtype=np.int32)
    y_native[logits > 0.5] = 1
    y_native[logits > 1.2] = 2
    y_native[logits < -0.5] = -2
    neutral_idx = rng.choice(n, size=max(1, n // 30), replace=False)
    y_native[neutral_idx] = 0
    from utils import LABEL_TO_INTERNAL
    y_internal = np.array([LABEL_TO_INTERNAL[int(v)] for v in y_native], dtype=np.int32)
    return TrainingFrame(
        X=X,
        y_internal=y_internal,
        y_native=y_native,
        closed_at=closed_at,
        entry_prices=np.ones(n, dtype=np.float64),
        symbols=np.array(["SYN"] * n),
        sides=np.array(["buy" if i % 2 == 0 else "sell" for i in range(n)]),
        sorted_chronologically=True,
    )


def fit_predict(
    X_train: np.ndarray,
    y_train: np.ndarray,
    X_eval: np.ndarray,
    n_classes: int,
) -> np.ndarray:
    """Fit ONLY on train; predict on eval. Never receives test labels."""
    present = np.unique(y_train)
    if len(present) < 2:
        return np.full(len(X_eval), int(y_train[0]), dtype=np.int32)
    params = dict(EVAL_XGB_PARAMS)
    remap = {int(c): i for i, c in enumerate(present)}
    inv_remap = {i: int(c) for c, i in remap.items()}
    y_mapped = np.array([remap[int(v)] for v in y_train], dtype=np.int32)
    params["num_class"] = len(present)
    model = XGBClassifier(**params)
    model.fit(X_train, y_mapped)
    pred_mapped = model.predict(X_eval).astype(np.int32)
    return np.array([inv_remap[int(p)] for p in pred_mapped], dtype=np.int32)


def evaluate_condition(
    frame: TrainingFrame,
    split,
    formulation: LabelFormulation,
    condition_name: str,
    feature_indices: List[int],
) -> Dict[str, Any]:
    X = select_feature_columns(frame.X, feature_indices)
    y = formulation.map_native_array(frame.y_native)

    X_train, y_train = X[split.train_idx], y[split.train_idx]
    X_val, y_val = X[split.val_idx], y[split.val_idx]
    X_test, y_test = X[split.test_idx], y[split.test_idx]

    verify_no_future_leakage(split.train_idx, split.val_idx, frame.closed_at)
    verify_no_future_leakage(split.train_idx, split.test_idx, frame.closed_at)
    verify_no_future_leakage(split.val_idx, split.test_idx, frame.closed_at)
    assert set(split.train_idx).isdisjoint(set(split.test_idx))
    assert set(split.train_idx).isdisjoint(set(split.val_idx))
    assert set(split.val_idx).isdisjoint(set(split.test_idx))

    y_val_pred = fit_predict(X_train, y_train, X_val, formulation.n_classes)
    y_test_pred = fit_predict(X_train, y_train, X_test, formulation.n_classes)

    return {
        "formulation": formulation.name,
        "n_classes": formulation.n_classes,
        "information_condition": condition_name,
        "role": INFORMATION_CONDITIONS[condition_name]["role"],
        "n_features": len(feature_indices),
        "class_names": dict(formulation.class_names),
        "train_class_counts": class_counts(y_train, formulation.n_classes),
        "val_class_counts": class_counts(y_val, formulation.n_classes),
        "test_class_counts": class_counts(y_test, formulation.n_classes),
        "validation": safe_classification_metrics(
            y_val, y_val_pred, formulation.n_classes, formulation.class_names
        ),
        "test": safe_classification_metrics(
            y_test, y_test_pred, formulation.n_classes, formulation.class_names
        ),
    }
