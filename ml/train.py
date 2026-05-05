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
    LABEL_NAMES,
)

# ── Paths ─────────────────────────────────────────────────────────────────────
DATA_PATH   = Path('data/training_export.csv')
OUTPUT_PATH = Path('models/model.onnx')

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
    X, y = load_training_data(DATA_PATH)

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

    print("  Training complete.")

    # ── 3. Feature importances ────────────────────────────────────────────────
    print("\n[3/4] Feature importances (top 10):")
    importances = model.feature_importances_

    # Pair names with importances and sort descending
    paired = sorted(
        zip(FEATURE_NAMES, importances),
        key=lambda x: x[1],
        reverse=True
    )

    print(f"\n  {'Feature':<20} {'Importance':>10}  {'Bar'}")
    print(f"  {'-'*20}  {'-'*10}  {'-'*30}")
    for name, score in paired[:10]:
        bar = '█' * int(score * 200)
        print(f"  {name:<20} {score:>10.4f}  {bar}")

    # Warn if symbol_index has near-zero importance
    # (means the model isn't using symbol identity at all)
    symbol_importance = dict(paired).get('symbol_index', 0)
    if symbol_importance < 0.01:
        print(
            "\n  NOTE: symbol_index importance is very low "
            f"({symbol_importance:.4f})."
        )
        print(
            "  This is normal with few symbols or few samples per symbol."
        )
        print(
            "  It will increase as more per-symbol simulations accumulate."
        )

    # ── 4. Export to ONNX ─────────────────────────────────────────────────────
    print(f"\n[4/4] Exporting to ONNX...")
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)

    initial_type = [('float_input', FloatTensorType([None, EXPECTED_FEATURES]))]

    onnx_model = convert_xgboost(
        model,
        initial_types=initial_type,
        target_opset=12,     # opset 12 is widely supported including onnxruntime-node
    )

    with open(OUTPUT_PATH, 'wb') as f:
        f.write(onnx_model.SerializeToString())

    size_kb = OUTPUT_PATH.stat().st_size / 1024
    print(f"  Saved to {OUTPUT_PATH} ({size_kb:.1f} KB)")

    # ── Done ──────────────────────────────────────────────────────────────────
    print("\n" + "=" * 60)
    print("  Training complete.")
    print(f"  Model: {OUTPUT_PATH}")
    print("")
    print("  Next steps:")
    print("    1. Run:    python validate.py")
    print("    2. Upload: models/model.onnx → production models/model.onnx")
    print("    3. Send:   /ml_reload to your Telegram bot")
    print("=" * 60)


if __name__ == '__main__':
    main()
