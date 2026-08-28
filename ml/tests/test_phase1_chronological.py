# ml/tests/test_phase1_chronological.py
from __future__ import annotations

import sys
from pathlib import Path

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
from utils import EXPECTED_FEATURES, LABEL_TO_INTERNAL, TECHNICAL_FEATURE_INDICES, FULL_FEATURE_INDICES


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
    ts = np.arange(n, dtype=np.int64) * 1000
    split = chronological_split(n, timestamps=ts)
    assert split.train_idx.max() < split.val_idx.min()
    assert split.val_idx.max() < split.test_idx.min()
    assert set(split.train_idx).isdisjoint(set(split.test_idx))
    verify_no_future_leakage(split.train_idx, split.val_idx, ts)
    verify_no_future_leakage(split.train_idx, split.test_idx, ts)


def test_no_future_in_training():
    n = 50
    ts = np.arange(n, dtype=np.int64)
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
    assert "chronological_split" in (ML_DIR / "evaluate.py").read_text()


def test_final_test_cannot_reach_fitting():
    from evaluate import fit_predict, make_synthetic_frame
    frame = make_synthetic_frame(n=100, seed=42)
    split = chronological_split(len(frame.X), timestamps=frame.closed_at)
    assert set(split.train_idx).isdisjoint(set(split.test_idx))
    y = FORMULATION_FIVE.map_native_array(frame.y_native)
    X_train = frame.X[split.train_idx]
    y_train = y[split.train_idx]
    X_test = frame.X[split.test_idx]
    pred = fit_predict(X_train, y_train, X_test, 5)
    assert len(pred) == len(split.test_idx)


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


if __name__ == "__main__":
    tests = [v for k, v in list(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for t in tests:
        try:
            t()
            print(f"  PASS  {t.__name__}")
        except Exception as e:
            failed += 1
            print(f"  FAIL  {t.__name__}: {e}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    sys.exit(1 if failed else 0)
