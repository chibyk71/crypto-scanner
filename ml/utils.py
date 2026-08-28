# ml/utils.py
# Shared helpers for train.py, validate.py, Phase 1 evaluation
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Tuple

import numpy as np
import pandas as pd

EXPECTED_FEATURES = 33
VALID_LABELS = {-2, -1, 0, 1, 2}
LABEL_TO_INTERNAL = {-2: 0, -1: 1, 0: 2, 1: 3, 2: 4}
INTERNAL_TO_LABEL = {v: k for k, v in LABEL_TO_INTERNAL.items()}
LABEL_NAMES = {
    0: "disaster (-2)",
    1: "loss     (-1)",
    2: "neutral  ( 0)",
    3: "good     (+1)",
    4: "monster  (+2)",
}

FEATURE_NAMES = [
    "rsi", "ema_short_dev", "ema_mid_dev", "ema_long_dev",
    "macd_line_norm", "macd_signal_norm", "macd_hist_norm",
    "stoch_k", "stoch_d", "atr_pct", "htf_adx",
    "percent_b", "bb_bandwidth", "momentum", "engulfing",
    "buy_mfe", "buy_mae", "buy_ratio",
    "sell_mfe", "sell_mae", "sell_ratio",
    "obv_delta_norm", "vwap_deviation", "vwma_vwap_spread", "rel_volume",
    "liquidity_sweep", "bb_squeeze_breakout",
    "prev_buy_outcome", "prev_buy_label",
    "prev_sell_outcome", "prev_sell_label",
    "time_since_last_sim",
    "symbol_index",
]

TECHNICAL_FEATURE_INDICES = list(range(0, 27))
HISTORY_FEATURE_INDICES = list(range(27, 33))
FULL_FEATURE_INDICES = list(range(0, EXPECTED_FEATURES))


@dataclass
class TrainingFrame:
    X: np.ndarray
    y_internal: np.ndarray
    y_native: np.ndarray
    closed_at: np.ndarray
    entry_prices: np.ndarray
    symbols: Optional[np.ndarray]
    sides: Optional[np.ndarray]
    sorted_chronologically: bool


def _parse_features_column(df: pd.DataFrame) -> Tuple[pd.DataFrame, int]:
    parsed, failures = [], 0
    for raw in df["features"]:
        try:
            if isinstance(raw, list):
                parsed.append(raw)
            elif isinstance(raw, str):
                parsed.append(json.loads(raw))
            else:
                parsed.append(None)
                failures += 1
        except (json.JSONDecodeError, TypeError):
            parsed.append(None)
            failures += 1
    df = df.copy()
    df["features_parsed"] = parsed
    return df, failures


def _resolve_closed_at(df: pd.DataFrame) -> np.ndarray:
    for candidate in ("closed_at", "closedAt", "closed_at_ms"):
        if candidate in df.columns:
            series = pd.to_numeric(df[candidate], errors="coerce")
            return series.fillna(0).astype(np.int64).values
    return np.zeros(len(df), dtype=np.int64)


def load_training_frame(
    csv_path: str | Path,
    *,
    sort_chronologically: bool = True,
    min_samples: int = 50,
    verbose: bool = True,
) -> TrainingFrame:
    csv_path = Path(csv_path)
    if not csv_path.exists():
        raise FileNotFoundError(
            f"Training data not found at {csv_path}\n"
            f"Send /export_training_data to Telegram and download the file."
        )
    if verbose:
        print(f"Loading {csv_path} ...")
    df = pd.read_csv(csv_path)
    total_rows = len(df)
    if verbose:
        print(f"  Raw rows loaded: {total_rows}")
    if total_rows == 0:
        raise ValueError("CSV is empty.")

    missing = {"features", "label"} - set(df.columns)
    if missing:
        raise ValueError(f"CSV missing columns: {missing}. Found: {list(df.columns)}")

    df, parse_failures = _parse_features_column(df)
    if parse_failures and verbose:
        print(f"  Dropped {parse_failures} rows with unparseable features")
    df = df[df["features_parsed"].notna()].copy()

    wrong = df["features_parsed"].apply(
        lambda x: not isinstance(x, list) or len(x) != EXPECTED_FEATURES
    )
    n_wrong = int(wrong.sum())
    if n_wrong and verbose:
        print(f"  Dropped {n_wrong} rows with wrong feature length")
    df = df[~wrong].copy()

    df["label"] = pd.to_numeric(df["label"], errors="coerce")
    invalid = ~df["label"].isin(VALID_LABELS)
    n_inv = int(invalid.sum())
    if n_inv and verbose:
        print(f"  Dropped {n_inv} rows with invalid labels")
    df = df[~invalid].copy()

    X = np.array(df["features_parsed"].tolist(), dtype=np.float32)
    bad = ~np.isfinite(X).all(axis=1)
    n_bad = int(bad.sum())
    if n_bad and verbose:
        print(f"  Dropped {n_bad} rows with NaN/Inf features")
    X = X[~bad]
    df = df.loc[~bad].copy()

    y_native = df["label"].astype(int).values.astype(np.int32)
    y_internal = np.array([LABEL_TO_INTERNAL[int(l)] for l in y_native], dtype=np.int32)
    closed_at = _resolve_closed_at(df)
    entry_prices = (
        np.array(df["entry_price"].astype(float).values, dtype=np.float64)
        if "entry_price" in df.columns
        else np.ones(len(X), dtype=np.float64)
    )
    symbols = df["symbol"].astype(str).values if "symbol" in df.columns else None
    sides = df["side"].astype(str).values if "side" in df.columns else None

    sorted_flag = False
    if sort_chronologically:
        order = np.argsort(closed_at, kind="mergesort")
        X = X[order]
        y_native = y_native[order]
        y_internal = y_internal[order]
        closed_at = closed_at[order]
        entry_prices = entry_prices[order]
        if symbols is not None:
            symbols = symbols[order]
        if sides is not None:
            sides = sides[order]
        sorted_flag = True
        if verbose and len(closed_at) > 1:
            n_zero = int((closed_at == 0).sum())
            if n_zero:
                print(f"  WARNING: {n_zero} rows have closed_at=0 (missing); sorted first")
            if np.any(np.diff(closed_at) < 0):
                raise RuntimeError("closed_at not non-decreasing after sort")

    if verbose:
        print(f"\n  Total rows:   {total_rows}")
        print(f"  Valid rows:   {len(X)}")
        print(f"  Dropped:      {total_rows - len(X)}")
        print(f"  Features:     {X.shape[1]}")
        print(f"  Chronological sort: {sorted_flag}")
        print("\n  Native label distribution (-2..+2):")
        for lab in sorted(VALID_LABELS):
            c = int((y_native == lab).sum())
            print(f"    {lab:+d}: {c:4d} ({c / max(len(y_native), 1) * 100:5.1f}%)")

    if len(X) < min_samples:
        raise ValueError(
            f"Only {len(X)} valid samples after filtering. Need at least {min_samples}."
        )

    return TrainingFrame(
        X=X,
        y_internal=y_internal,
        y_native=y_native,
        closed_at=closed_at,
        entry_prices=entry_prices,
        symbols=symbols,
        sides=sides,
        sorted_chronologically=sorted_flag,
    )


def load_training_data(csv_path: str | Path) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Backward-compatible loader for train.py (no chronological sort). """
    frame = load_training_frame(csv_path, sort_chronologically=False, verbose=True)
    return frame.X, frame.y_internal, frame.entry_prices


def check_class_balance(y: np.ndarray, min_samples_per_class: int = 10) -> bool:
    unique, counts = np.unique(y, return_counts=True)
    dist = dict(zip(unique, counts))
    ok = True
    for internal_label in range(5):
        count = dist.get(internal_label, 0)
        if count < min_samples_per_class:
            print(
                f"  WARNING: {LABEL_NAMES[internal_label]} has only "
                f"{count} samples (min recommended: {min_samples_per_class})"
            )
            ok = False
    return ok


def select_feature_columns(X: np.ndarray, indices: list) -> np.ndarray:
    return X[:, indices].astype(np.float32, copy=False)
