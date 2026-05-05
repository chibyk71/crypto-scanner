# ml/utils.py
# =============================================================================
# Shared helpers for train.py and validate.py
#
# Responsibilities:
#   - Load and parse training_export.csv
#   - Parse the features JSON string column into a float array
#   - Validate feature vector length
#   - Filter out bad rows (wrong length, NaN, Infinity, invalid labels)
#   - Map labels -2..+2 to internal 0..4 for XGBoost
#   - Print a clear summary of what was loaded and what was dropped
# =============================================================================

import json
import pandas as pd
import numpy as np
from pathlib import Path

# Must match expectedLength in mlService.ts
EXPECTED_FEATURES = 26

# Labels your bot produces
VALID_LABELS = {-2, -1, 0, 1, 2}

# XGBoost requires classes 0..N, so we remap
LABEL_TO_INTERNAL = {-2: 0, -1: 1, 0: 2, 1: 3, 2: 4}
INTERNAL_TO_LABEL = {v: k for k, v in LABEL_TO_INTERNAL.items()}

# Human readable names for reporting
LABEL_NAMES = {
    0: 'disaster (-2)',
    1: 'loss     (-1)',
    2: 'neutral  ( 0)',
    3: 'good     (+1)',
    4: 'monster  (+2)',
}

FEATURE_NAMES = [
    'rsi', 'ema_short_dev', 'ema_mid_dev', 'ema_long_dev',
    'macd_line', 'macd_signal', 'macd_hist',
    'stoch_k', 'stoch_d', 'atr_pct', 'htf_adx',
    'percent_b', 'bb_bandwidth', 'momentum', 'engulfing',
    'buy_mfe', 'buy_mae', 'buy_ratio',
    'sell_mfe', 'sell_mae', 'sell_ratio',
    'obv', 'vwap', 'vwma', 'price_scaled',
    'symbol_index',
]


def load_training_data(csv_path: str | Path) -> tuple[np.ndarray, np.ndarray]:
    """
    Load, parse, and clean the exported training CSV.

    Returns:
        X: float32 array of shape (n_samples, EXPECTED_FEATURES)
        y: int array of shape (n_samples,) with values 0..4 (remapped labels)

    Raises:
        FileNotFoundError: if the CSV does not exist
        ValueError: if fewer than 50 valid samples remain after filtering
    """
    csv_path = Path(csv_path)

    if not csv_path.exists():
        raise FileNotFoundError(
            f"Training data not found at {csv_path}\n"
            f"Send /export_training_data to your Telegram bot and download the file."
        )

    print(f"Loading {csv_path} ...")
    df = pd.read_csv(csv_path)
    total_rows = len(df)
    print(f"  Raw rows loaded: {total_rows}")

    if total_rows == 0:
        raise ValueError("CSV is empty.")

    # ── Validate required columns ─────────────────────────────────────────────
    required_columns = {'features', 'label'}
    missing = required_columns - set(df.columns)
    if missing:
        raise ValueError(
            f"CSV is missing required columns: {missing}\n"
            f"Found columns: {list(df.columns)}"
        )

    # ── Parse features column ─────────────────────────────────────────────────
    # The features column is a JSON string like "[0.5, 0.3, ...]"
    # We parse each row individually so bad rows can be reported and dropped
    parsed_features = []
    parse_failures = 0

    for i, raw in enumerate(df['features']):
        try:
            if isinstance(raw, list):
                # Already parsed (shouldn't happen with CSV but handle it)
                parsed_features.append(raw)
            elif isinstance(raw, str):
                parsed_features.append(json.loads(raw))
            else:
                parsed_features.append(None)
                parse_failures += 1
        except (json.JSONDecodeError, TypeError):
            parsed_features.append(None)
            parse_failures += 1

    df['features_parsed'] = parsed_features

    if parse_failures > 0:
        print(f"  Dropped {parse_failures} rows with unparseable features column")

    # ── Filter: remove None (failed parse) ───────────────────────────────────
    df = df[df['features_parsed'].notna()].copy()

    # ── Filter: wrong feature vector length ───────────────────────────────────
    wrong_length = df['features_parsed'].apply(
        lambda x: not isinstance(x, list) or len(x) != EXPECTED_FEATURES
    )
    n_wrong = wrong_length.sum()
    if n_wrong > 0:
        # Show what lengths we actually got so you can debug
        lengths = df.loc[wrong_length, 'features_parsed'].apply(
            lambda x: len(x) if isinstance(x, list) else 'not a list'
        ).value_counts()
        print(f"  Dropped {n_wrong} rows with wrong feature length "
              f"(expected {EXPECTED_FEATURES}):")
        for length, count in lengths.items():
            print(f"    length {length}: {count} rows")
    df = df[~wrong_length].copy()

    # ── Filter: invalid labels ────────────────────────────────────────────────
    df['label'] = pd.to_numeric(df['label'], errors='coerce')
    invalid_labels = ~df['label'].isin(VALID_LABELS)
    n_invalid = invalid_labels.sum()
    if n_invalid > 0:
        print(f"  Dropped {n_invalid} rows with invalid labels "
              f"(valid: {sorted(VALID_LABELS)})")
    df = df[~invalid_labels].copy()

    # ── Build X matrix ────────────────────────────────────────────────────────
    X = np.array(df['features_parsed'].tolist(), dtype=np.float32)

    # ── Filter: NaN or Infinity in features ───────────────────────────────────
    bad_rows = ~np.isfinite(X).all(axis=1)
    n_bad = bad_rows.sum()
    if n_bad > 0:
        print(f"  Dropped {n_bad} rows with NaN or Infinity in features")
    X = X[~bad_rows]
    df = df[~bad_rows].copy()

    # ── Remap labels to internal 0..4 ─────────────────────────────────────────
    y_raw = df['label'].astype(int).values
    y = np.array([LABEL_TO_INTERNAL[l] for l in y_raw], dtype=np.int32)

    # ── Summary ───────────────────────────────────────────────────────────────
    dropped = total_rows - len(X)
    print(f"\n  Total rows:   {total_rows}")
    print(f"  Valid rows:   {len(X)}")
    print(f"  Dropped:      {dropped}")
    print(f"  Features:     {X.shape[1]}")

    if len(X) < 50:
        raise ValueError(
            f"Only {len(X)} valid samples after filtering. "
            f"Need at least 50 to train. Collect more simulations."
        )

    # ── Class distribution ────────────────────────────────────────────────────
    print("\n  Class distribution:")
    unique, counts = np.unique(y, return_counts=True)
    for u, c in zip(unique, counts):
        bar = '█' * int(c / len(y) * 40)
        print(f"    {LABEL_NAMES[u]}: {c:4d} ({c/len(y)*100:5.1f}%)  {bar}")

    return X, y


def check_class_balance(y: np.ndarray, min_samples_per_class: int = 10) -> bool:
    """
    Warns if any class has fewer than min_samples_per_class samples.
    Returns True if balance is acceptable, False if something looks wrong.
    """
    unique, counts = np.unique(y, return_counts=True)
    dist = dict(zip(unique, counts))
    ok = True

    for internal_label in range(5):
        count = dist.get(internal_label, 0)
        if count < min_samples_per_class:
            print(f"  WARNING: {LABEL_NAMES[internal_label]} has only "
                  f"{count} samples (min recommended: {min_samples_per_class})")
            ok = False

    return ok
