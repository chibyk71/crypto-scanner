# ml/tests/test_phase1_chronological.py
from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import patch

import numpy as np

ML_DIR = Path(__file__).resolve().parents[1]
if str(ML_DIR) not in sys.path:
    sys.path.insert(0, str(ML_DIR))

from chronological import (
    assert_chronological,
    chronological_split,
    sort_by_time,
    verify_no_future_leakage,
    walk_forward_windows,
)
from labels import FORMULATION_FIVE, FORMULATION_FOUR, FORMULATION_THREE, class_counts
from metrics_report import safe_classification_metrics
from utils import (
    EXPECTED_FEATURES,
    FULL_FEATURE_INDICES,
    LABEL_TO_INTERNAL,
    MIN_VALID_CLOSED_AT_MS,
    TECHNICAL_FEATURE_INDICES,
    is_valid_closed_at,
    load_training_frame,
)


def test_chronological_sorting():
    ts = np.array([3, 1, 2, 2, 5], dtype=np.int64)
    y = np.arange(5)
    ts_s, y_s = sort_by_time(ts, y)
    assert_chronological(ts_s, allow_equal=True)
    assert list(ts_s) == [1, 2, 2, 3, 5]
    assert list(y_s) == [1, 2, 3, 0, 4]


def test_equal_timestamps_stable():
    ts = np.array([1, 2, 2, 2, 3], dtype=np.int64)
    ids = np.array([10, 20, 21, 22, 30])
    ts_s, ids_s = sort_by_time(ts, ids)
    assert list(ids_s[1:4]) == [20, 21, 22]


def test_train_val_test_boundaries():
    n = 100
    ts = np.arange(n, dtype=np.int64) * 1000 + MIN_VALID_CLOSED_AT_MS
    split = chronological_split(n, timestamps=ts)
    assert split.train_idx.max() < split.val_idx.min()
    assert split.val_idx.max() < split.test_idx.min()
    assert set(split.train_idx).isdisjoint(set(split.test_idx))
    verify_no_future_leakage(split.train_idx, split.val_idx, ts)
    verify_no_future_leakage(split.train_idx, split.test_idx, ts)


def test_no_future_in_training():
    n = 50
    ts = np.arange(n, dtype=np.int64) + MIN_VALID_CLOSED_AT_MS
    split = chronological_split(n, timestamps=ts)
    assert ts[split.train_idx].max() <= ts[split.test_idx].min()


def test_deterministic_split():
    n = 80
    s1 = chronological_split(n)
    s2 = chronological_split(n)
    assert np.array_equal(s1.train_idx, s2.train_idx)
    assert np.array_equal(s1.test_idx, s2.test_idx)


def test_label_mappings():
    native = np.array([-2, -1, 0, 1, 2], dtype=np.int32)
    assert list(FORMULATION_FIVE.map_native_array(native)) == [0, 1, 2, 3, 4]
    assert list(FORMULATION_FOUR.map_native_array(native)) == [0, 1, 2, 3, 3]
    assert list(FORMULATION_THREE.map_native_array(native)) == [0, 0, 1, 2, 2]
    internal = np.array([0, 1, 2, 3, 4], dtype=np.int32)
    assert list(FORMULATION_THREE.map_internal_five(internal)) == [0, 0, 1, 2, 2]


def test_class_counts():
    y = np.array([0, 0, 1, 2, 2, 2], dtype=np.int32)
    c = class_counts(y, 3)
    assert c[0] == 2 and c[1] == 1 and c[2] == 3
    assert class_counts(y, 5)[4] == 0


def test_rare_missing_class_metrics():
    y_true = np.array([0, 0, 1, 1], dtype=np.int32)
    y_pred = np.array([0, 1, 1, 1], dtype=np.int32)
    m = safe_classification_metrics(y_true, y_pred, n_classes=5)
    assert 2 in m["missing_classes"]
    assert m["per_class"][2]["support"] == 0
    assert m["per_class"][2]["precision"] == 0.0


def test_no_train_test_split_in_primary_path():
    def active(src: str) -> str:
        lines = []
        for line in src.splitlines():
            s = line.strip()
            if not s or s.startswith("#"):
                continue
            lines.append(s.split("#")[0])
        return "\n".join(lines)
    v = active((ML_DIR / "validate.py").read_text())
    e = active((ML_DIR / "evaluate.py").read_text())
    assert "from sklearn.model_selection import train_test_split" not in v
    assert "from sklearn.model_selection import train_test_split" not in e
    assert "train_test_split(" not in v
    assert "train_test_split(" not in e
    assert "chronological_split" in (ML_DIR / "validate.py").read_text()
    assert "chronological_split" in (ML_DIR / "evaluate.py").read_text() or \
           "chronological_split" in (ML_DIR / "evaluate_lib.py").read_text()


def test_final_test_cannot_reach_fitting():
    """Spy on XGBClassifier.fit to prove only train rows are fitted."""
    from evaluate import fit_predict, make_synthetic_frame
    from xgboost import XGBClassifier

    frame = make_synthetic_frame(n=100, seed=42)
    split = chronological_split(len(frame.X), timestamps=frame.closed_at)
    assert set(split.train_idx).isdisjoint(set(split.test_idx))
    y = FORMULATION_FIVE.map_native_array(frame.y_native)
    X_train = frame.X[split.train_idx]
    y_train = y[split.train_idx]
    X_test = frame.X[split.test_idx]

    fit_call_shapes = []
    original_fit = XGBClassifier.fit

    def spy_fit(self, X, y, *args, **kwargs):
        fit_call_shapes.append((np.asarray(X).shape[0], np.asarray(y).shape[0]))
        assert np.asarray(X).shape[0] == len(X_train)
        assert np.asarray(y).shape[0] == len(y_train)
        return original_fit(self, X, y, *args, **kwargs)

    with patch.object(XGBClassifier, "fit", spy_fit):
        pred = fit_predict(X_train, y_train, X_test, 5)

    assert len(pred) == len(split.test_idx)
    assert len(fit_call_shapes) >= 1
    for n_x, n_y in fit_call_shapes:
        assert n_x == len(X_train)
        assert n_y == len(y_train)


def test_feature_dimensions():
    assert EXPECTED_FEATURES == 33
    assert len(TECHNICAL_FEATURE_INDICES) == 27
    assert len(FULL_FEATURE_INDICES) == 33
    assert TECHNICAL_FEATURE_INDICES[-1] == 26


def test_unsorted_timestamps_rejected():
    ts = np.array([10, 5, 6], dtype=np.int64)
    try:
        chronological_split(3, timestamps=ts)
        raised = False
    except ValueError:
        raised = True
    assert raised


def test_walk_forward_windows_valid():
    windows = walk_forward_windows(n=100, n_splits=4, min_train_ratio=0.4, test_ratio=0.15)
    assert len(windows) >= 1
    prev_test_start = -1
    for w in windows:
        assert w.train_idx.max() < w.test_idx.min()
        assert w.test_idx.max() < 100
        assert int(w.test_idx.min()) > prev_test_start
        prev_test_start = int(w.test_idx.min())


def test_assert_chronological_strict_vs_equal():
    ts_eq = np.array([1, 2, 2, 3], dtype=np.int64)
    assert_chronological(ts_eq, allow_equal=True)
    try:
        assert_chronological(ts_eq, allow_equal=False)
        ok = False
    except ValueError:
        ok = True
    assert ok


def test_synthetic_leakage_pattern_caught():
    ts = np.array([1, 3, 2, 4], dtype=np.int64)
    try:
        assert_chronological(ts)
        caught = False
    except ValueError:
        caught = True
    assert caught
    train_idx = np.array([2, 3])
    held = np.array([0, 1])
    ts2 = np.array([10, 20, 30, 40], dtype=np.int64)
    try:
        verify_no_future_leakage(train_idx, held, ts2)
        caught2 = False
    except AssertionError:
        caught2 = True
    assert caught2


def test_evaluation_deterministic():
    from evaluate import fit_predict, make_synthetic_frame
    frame = make_synthetic_frame(n=120, seed=42)
    split = chronological_split(len(frame.X), timestamps=frame.closed_at)
    y = FORMULATION_FIVE.map_native_array(frame.y_native)
    X_train, y_train = frame.X[split.train_idx], y[split.train_idx]
    X_test = frame.X[split.test_idx]
    p1 = fit_predict(X_train, y_train, X_test, 5)
    p2 = fit_predict(X_train, y_train, X_test, 5)
    assert np.array_equal(p1, p2)


def test_missing_closed_at_not_coerced_to_zero():
    """Invalid/missing closed_at must NOT become timestamp 0."""
    assert not is_valid_closed_at(0)
    assert not is_valid_closed_at(None)
    assert not is_valid_closed_at(float("nan"))
    assert not is_valid_closed_at(-1)
    assert not is_valid_closed_at(1_000_000)
    assert is_valid_closed_at(MIN_VALID_CLOSED_AT_MS)
    assert is_valid_closed_at(1_700_000_000_000)


def test_invalid_timestamps_dropped_from_evaluation_path(tmp_path):
    """Evaluation path drops invalid closed_at; never invents epoch-0."""
    import json
    import pandas as pd

    n = 60
    t0 = MIN_VALID_CLOSED_AT_MS + 86_400_000
    rows = []
    for i in range(n):
        if i % 10 == 0:
            closed = None if i % 20 == 0 else 0
        else:
            closed = t0 + i * 60_000
        rows.append({
            "features": json.dumps([0.1] * EXPECTED_FEATURES),
            "label": int([-2, -1, 0, 1, 2][i % 5]),
            "closed_at": closed,
            "entry_price": 100.0,
            "symbol": "TEST",
            "side": "buy",
        })
    csv_path = tmp_path / "bad_ts.csv"
    pd.DataFrame(rows).to_csv(csv_path, index=False)

    frame = load_training_frame(
        csv_path, sort_chronologically=True, min_samples=10, verbose=False
    )
    assert frame.n_dropped_invalid_timestamp == 6
    assert len(frame.X) == n - 6
    assert np.all(frame.closed_at >= MIN_VALID_CLOSED_AT_MS)
    assert not np.any(frame.closed_at == 0)
    assert np.all(np.diff(frame.closed_at) >= 0)


def test_all_invalid_timestamps_fail_loudly(tmp_path):
    """If every row has invalid closed_at, evaluation path must raise."""
    import json
    import pandas as pd

    rows = []
    for i in range(20):
        rows.append({
            "features": json.dumps([0.1] * EXPECTED_FEATURES),
            "label": 1,
            "closed_at": 0,
            "entry_price": 100.0,
        })
    csv_path = tmp_path / "all_bad.csv"
    pd.DataFrame(rows).to_csv(csv_path, index=False)

    try:
        load_training_frame(
            csv_path, sort_chronologically=True, min_samples=5, verbose=False
        )
        raised = False
    except ValueError as e:
        raised = True
        assert "invalid" in str(e).lower() or "cannot be established" in str(e).lower()
    assert raised


def test_validate_does_not_claim_oos():
    """validate.py must not claim hold-out / OOS validation."""
    src = (ML_DIR / "validate.py").read_text().lower()
    assert "not out-of-sample" in src or "not genuine out-of-sample" in src
    assert "evaluate.py" in src
    assert "smoke" in src
    assert "safe to upload" not in src


def test_partition_design_documented():
    """Validation is diagnostic only; no selection on test."""
    lib = (ML_DIR / "evaluate_lib.py").read_text()
    eval_src = (ML_DIR / "evaluate.py").read_text()
    assert "not used for selection" in lib or "diagnostic" in lib
    assert "partition_design" in eval_src
    assert "not used for model/formulation/hyperparameter selection" in eval_src
    assert "no winner is selected" in eval_src.lower() or "no winner is" in eval_src.lower()
    assert "provisional pending more data" not in eval_src


def test_signal_subset_terminology():
    """technical_only key is the 27-feature signal-input subset, not production score."""
    from evaluate_lib import INFORMATION_CONDITIONS
    tech = INFORMATION_CONDITIONS["technical_only"]
    full = INFORMATION_CONDITIONS["full_feature_ml"]
    assert len(tech["indices"]) == 27
    assert len(full["indices"]) == 33
    desc = tech["description"].lower()
    assert "not a replay" in desc or "measurement baseline" in desc
    assert "buyscore" in tech["description"] or "production score" in tech["role"].lower()
    assert "not" in full["role"].lower() and "ml-only" in full["role"].lower().replace(" ", "")


if __name__ == "__main__":
    import tempfile
    from pathlib import Path as P

    tests = [v for k, v in list(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for t in tests:
        try:
            import inspect
            sig = inspect.signature(t)
            if "tmp_path" in sig.parameters:
                with tempfile.TemporaryDirectory() as d:
                    t(P(d))
            else:
                t()
            print(f"  PASS  {t.__name__}")
        except Exception as e:
            failed += 1
            print(f"  FAIL  {t.__name__}: {e}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    sys.exit(1 if failed else 0)
