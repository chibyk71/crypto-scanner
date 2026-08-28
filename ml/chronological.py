# ml/chronological.py
# Phase 1 — Chronological split primitives (leakage-safe time-series partitions)
# Ordering key: closed_at (Unix ms). Export is DESC; evaluation always sorts ASC.
# Equal timestamps: stable mergesort preserves original relative order.
# Phase 11 readiness: walk_forward_windows is an INDEX primitive only.
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional, Tuple

import numpy as np


@dataclass(frozen=True)
class ChronoSplit:
    train_idx: np.ndarray
    val_idx: np.ndarray
    test_idx: np.ndarray
    n: int
    train_ratio: float
    val_ratio: float
    test_ratio: float

    @property
    def train_size(self) -> int:
        return int(len(self.train_idx))

    @property
    def val_size(self) -> int:
        return int(len(self.val_idx))

    @property
    def test_size(self) -> int:
        return int(len(self.test_idx))


@dataclass(frozen=True)
class ChronoWindow:
    train_idx: np.ndarray
    test_idx: np.ndarray
    window_id: int


def assert_chronological(timestamps: np.ndarray, *, allow_equal: bool = True) -> None:
    """Raise if timestamps are not ordered ascending.
    allow_equal=True (default): non-decreasing (ties OK).
    allow_equal=False: strictly increasing.
    """
    if len(timestamps) < 2:
        return
    diffs = np.diff(timestamps.astype(np.int64))
    if allow_equal:
        if np.any(diffs < 0):
            bad = int(np.where(diffs < 0)[0][0])
            raise ValueError(
                f"Timestamps not chronological at index {bad}: "
                f"{timestamps[bad]} > {timestamps[bad + 1]}"
            )
    else:
        if np.any(diffs <= 0):
            bad = int(np.where(diffs <= 0)[0][0])
            raise ValueError(
                f"Timestamps not strictly increasing at index {bad}: "
                f"{timestamps[bad]} >= {timestamps[bad + 1]}"
            )


def sort_by_time(timestamps: np.ndarray, *arrays: np.ndarray) -> Tuple[np.ndarray, ...]:
    """Stable ASC sort by timestamps (mergesort). Ties keep relative order."""
    order = np.argsort(timestamps.astype(np.int64), kind="mergesort")
    out = [timestamps[order]]
    for a in arrays:
        out.append(a[order])
    return tuple(out)


def chronological_split(
    n: int,
    train_ratio: float = 0.60,
    val_ratio: float = 0.20,
    test_ratio: float = 0.20,
    timestamps: Optional[np.ndarray] = None,
) -> ChronoSplit:
    """Fixed chronological 60/20/20 on indices 0..n-1. Rows MUST be sorted ASC by closed_at."""
    if n < 3:
        raise ValueError(f"Need at least 3 samples for chronological split, got {n}")
    total = train_ratio + val_ratio + test_ratio
    if abs(total - 1.0) > 1e-6:
        raise ValueError(f"Ratios must sum to 1.0, got {total}")
    if timestamps is not None:
        if len(timestamps) != n:
            raise ValueError("timestamps length must equal n")
        assert_chronological(timestamps, allow_equal=True)
    n_train = int(n * train_ratio)
    n_val = int(n * val_ratio)
    n_test = n - n_train - n_val
    if n_train < 1 or n_val < 1 or n_test < 1:
        raise ValueError(f"Split too small for n={n}: train={n_train}, val={n_val}, test={n_test}")
    train_idx = np.arange(0, n_train, dtype=np.int64)
    val_idx = np.arange(n_train, n_train + n_val, dtype=np.int64)
    test_idx = np.arange(n_train + n_val, n, dtype=np.int64)
    if train_idx.max() >= val_idx.min():
        raise AssertionError("Train overlaps validation")
    if val_idx.max() >= test_idx.min():
        raise AssertionError("Validation overlaps test")
    if train_idx.max() >= test_idx.min():
        raise AssertionError("Train overlaps test")
    return ChronoSplit(
        train_idx=train_idx, val_idx=val_idx, test_idx=test_idx, n=n,
        train_ratio=train_ratio, val_ratio=val_ratio, test_ratio=test_ratio,
    )


def walk_forward_windows(
    n: int, n_splits: int = 4, min_train_ratio: float = 0.40, test_ratio: float = 0.15,
) -> list:
    """Expanding-window index partitions (Phase 11 readiness ONLY)."""
    if n_splits < 1:
        raise ValueError("n_splits must be >= 1")
    test_size = max(1, int(n * test_ratio))
    min_train = max(1, int(n * min_train_ratio))
    available = n - min_train
    if available < test_size:
        raise ValueError(f"n={n} too small for min_train={min_train} and test_size={test_size}")
    step = max(1, (available - test_size) // max(1, n_splits - 1)) if n_splits > 1 else 0
    windows = []
    seen_test_starts = set()
    for i in range(n_splits):
        train_end = min_train + i * step
        test_start = train_end
        test_end = min(test_start + test_size, n)
        if test_end <= test_start or train_end < 1:
            break
        if test_start in seen_test_starts:
            continue
        seen_test_starts.add(test_start)
        train_idx = np.arange(0, train_end, dtype=np.int64)
        test_idx = np.arange(test_start, test_end, dtype=np.int64)
        if train_idx.max() >= test_idx.min():
            raise AssertionError("walk_forward window train/test overlap")
        windows.append(ChronoWindow(train_idx=train_idx, test_idx=test_idx, window_id=i))
    return windows


def verify_no_future_leakage(train_idx, heldout_idx, timestamps) -> None:
    if len(train_idx) == 0 or len(heldout_idx) == 0:
        return
    t_train = timestamps[train_idx]
    t_held = timestamps[heldout_idx]
    if t_train.max() > t_held.min():
        raise AssertionError(
            f"Leakage: train max time {t_train.max()} > held-out min time {t_held.min()}"
        )


def time_range_summary(timestamps, idx) -> dict:
    if len(idx) == 0:
        return {"n": 0, "t_min": None, "t_max": None, "t_min_iso": None, "t_max_iso": None}
    ts = timestamps[idx]
    def iso(ms: int) -> str:
        return datetime.fromtimestamp(ms / 1000.0, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {
        "n": int(len(idx)), "t_min": int(ts.min()), "t_max": int(ts.max()),
        "t_min_iso": iso(int(ts.min())), "t_max_iso": iso(int(ts.max())),
    }


def count_boundary_ties(timestamps, split) -> dict:
    def edge_ties(left_idx, right_idx):
        if len(left_idx) == 0 or len(right_idx) == 0:
            return 0
        return int(timestamps[left_idx[-1]] == timestamps[right_idx[0]])
    return {
        "train_val_boundary_same_ts": edge_ties(split.train_idx, split.val_idx),
        "val_test_boundary_same_ts": edge_ties(split.val_idx, split.test_idx),
        "note": (
            "If 1, last train and first val (or val/test) share closed_at. "
            "Rows are non-overlapping by index; same-ms events may be concurrent."
        ),
    }
