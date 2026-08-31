# ml/train.py
# =============================================================================
# Main training script
#
# Usage:
#   cd ml
#   python train.py
#
# What it does:
#   1. Loads ml/data/training_export.csv
#   2. Parses and cleans via utils.py
#   3. Trains XGBoost classifier
#   4. Prints feature importances so you can see what the model learned
#   5. Exports to ml/models/model.onnx
#
# Run validate.py after this before uploading to production.
# =============================================================================

import numpy as np
from pathlib import Path
from xgboost import XGBClassifier
from onnxmltools import convert_xgboost
from onnxmltools.convert.common.data_types import FloatTensorType
import onnx

from utils import (
    load_training_data,
    check_class_balance,
    EXPECTED_FEATURES,
    FEATURE_NAMES,
)

# ── Paths ─────────────────────────────────────────────────────────────────────
# Prefer training_export.csv (Telegram /export_training_data), fall back to
# simulated_trades.csv — same order as validate.py and evaluate_lib.
DATA_CANDIDATES = [
    Path('data/training_export.csv'),
    Path('data/simulated_trades.csv'),
]
OUTPUT_PATH = Path('models/model.onnx')


def _resolve_data_path() -> Path:
    for p in DATA_CANDIDATES:
        if p.exists():
            return p
    raise FileNotFoundError(
        'Training data not found. Tried: '
        + ', '.join(str(p) for p in DATA_CANDIDATES)
        + '. Export via Telegram /export_training_data and place at '
        'ml/data/training_export.csv'
    )

# ── XGBoost hyperparameters ───────────────────────────────────────────────────
# Tuned for small-to-medium tabular datasets (500–5000 rows)
# Adjust n_estimators and max_depth upward as you collect more data
XGBOOST_PARAMS = dict(
    n_estimators      = 300,
    max_depth         = 6,
    learning_rate     = 0.05,
    subsample         = 0.8,       # row sampling per tree (reduces overfitting)
    colsample_bytree  = 0.8,       # feature sampling per tree
    min_child_weight  = 3,         # minimum samples in a leaf
    gamma             = 0.1,       # minimum loss reduction to split
    objective         = 'multi:softprob',
    num_class         = 5,         # labels 0..4 (remapped from -2..+2)
    eval_metric       = 'mlogloss',
    random_state      = 42,
    n_jobs            = -1,        # use all CPU cores
)


def main():
    print("=" * 60)
    print("  Crypto Scanner — XGBoost Training")
    print("=" * 60)

    # ── 1. Load and clean data ────────────────────────────────────────────────
    print("\n[1/4] Loading training data...")
    data_path = _resolve_data_path()
    print(f"  Using: {data_path}")
    X, y, entry_prices = load_training_data(data_path)

    # Warn if any class is severely underrepresented
    print("\n  Checking class balance...")
    balanced = check_class_balance(y, min_samples_per_class=10)
    if not balanced:
        print("\n  Classes with very few samples will be predicted poorly.")
        print("  Consider collecting more simulations before retraining.")
        answer = input("\n  Continue anyway? (y/n): ").strip().lower()
        if answer != 'y':
            print("  Aborted. Collect more samples and retry.")
            return

    # ── 2. Train ──────────────────────────────────────────────────────────────
    print(f"\n[2/4] Training XGBoost on {len(X)} samples, "
          f"{X.shape[1]} features...")
    print(f"  Parameters: depth={XGBOOST_PARAMS['max_depth']}, "
          f"trees={XGBOOST_PARAMS['n_estimators']}, "
          f"lr={XGBOOST_PARAMS['learning_rate']}")

    model = XGBClassifier(**XGBOOST_PARAMS)
    model.fit(X, y)

    # ── 3. Feature importances ────────────────────────────────────────────────
    print("\n[3/4] Feature importances (top 15):")
    importances = model.feature_importances_
    ranked = sorted(zip(FEATURE_NAMES, importances), key=lambda x: -x[1])
    for name, imp in ranked[:15]:
        print(f"  {name:25s} {imp:.4f}")

    # ── 4. Export ONNX ────────────────────────────────────────────────────────
    print(f"\n[4/4] Exporting ONNX to {OUTPUT_PATH}...")
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    initial_type = [('float_input', FloatTensorType([None, EXPECTED_FEATURES]))]
    onnx_model = convert_xgboost(model, initial_types=initial_type)
    onnx.save_model(onnx_model, str(OUTPUT_PATH))
    print(f"  Saved {OUTPUT_PATH} ({OUTPUT_PATH.stat().st_size // 1024} KB)")
    print("\nDone. Run validate.py before uploading to production.")


if __name__ == '__main__':
    main()
