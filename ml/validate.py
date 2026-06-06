# ml/validate.py
# =============================================================================
# Pre-upload sanity check for the trained ONNX model
#
# Usage:
#   cd ml
#   python validate.py
#
# What it checks:
#   1. Model file exists and is valid ONNX
#   2. Input shape matches what mlService.ts expects (26 features)
#   3. Output shape is correct (5 probabilities per sample)
#   4. Output node name is 'probabilities' (what mlService.ts reads)
#   5. Runs inference on a held-out slice of your actual data
#   6. Per-class accuracy — flags any class with 0% prediction rate
#   7. Overall accuracy and confidence distribution
#
# If anything fails, do NOT upload. Fix the issue and retrain.
# =============================================================================

import numpy as np
import onnx
import onnxruntime as rt
from pathlib import Path
from sklearn.model_selection import train_test_split
from sklearn.metrics import confusion_matrix, classification_report

from utils import (
    load_training_data,
    EXPECTED_FEATURES,
    LABEL_NAMES,
    INTERNAL_TO_LABEL,
)

# ── Paths ─────────────────────────────────────────────────────────────────────
DATA_PATH   = Path('data/training_export.csv')
MODEL_PATH  = Path('models/model.onnx')

# Minimum acceptable per-class accuracy to pass validation
# Set low intentionally — the goal is catching complete collapse (0%),
# not demanding perfection on imbalanced classes
MIN_CLASS_ACCURACY = 0.05   # 5%

# Minimum overall accuracy to pass
MIN_OVERALL_ACCURACY = 0.35  # 35%


def check_model_structure(model_path: Path) -> bool:
    """
    Validates the ONNX model structure before running inference.
    Returns True if everything looks correct.
    """
    print("[1/4] Checking model structure...")

    # ── Load and validate ONNX file ───────────────────────────────────────────
    try:
        model = onnx.load(str(model_path))
        onnx.checker.check_model(model)
        print("  ONNX file is valid.")
    except Exception as e:
        print(f"  FAILED: ONNX model is invalid: {e}")
        return False

    # ── Check input shape ─────────────────────────────────────────────────────
    try:
        input_info  = model.graph.input[0]
        input_shape = [
            d.dim_value
            for d in input_info.type.tensor_type.shape.dim
        ]
        # Shape is [batch_size, n_features] — batch dim is 0 (dynamic)
        n_features = input_shape[1] if len(input_shape) > 1 else input_shape[0]

        if n_features != EXPECTED_FEATURES:
            print(
                f"  FAILED: Model expects {n_features} features, "
                f"but mlService.ts sends {EXPECTED_FEATURES}."
            )
            print(
                f"  This usually means the model was trained with a different "
                f"feature vector. Retrain."
            )
            return False

        print(f"  Input shape: {input_shape} ✓  ({n_features} features)")
    except Exception as e:
        print(f"  WARNING: Could not read input shape: {e}")
        print(f"  Continuing — will verify through inference.")

    # ── Check output nodes ────────────────────────────────────────────────────
    output_names = [o.name for o in model.graph.output]
    print(f"  Output nodes: {output_names}")

    if 'probabilities' not in output_names:
        print(
            f"  FAILED: Expected output node 'probabilities' not found."
        )
        print(
            f"  mlService.ts reads results['probabilities'] — "
            f"this will crash at inference time."
        )
        print(f"  Available outputs: {output_names}")
        return False

    print(f"  Output node 'probabilities' found ✓")
    return True


def run_inference_validation(model_path: Path, X: np.ndarray, y: np.ndarray) -> bool:
    """
    Runs the model against a held-out test slice and checks per-class accuracy.
    Returns True if the model passes all checks.
    """
    print("\n[2/4] Splitting data for validation...")

    # Use 20% of data as held-out test set
    # If fewer than 100 samples, use 10% to preserve training data insight
    test_size = 0.2 if len(X) >= 100 else 0.1
    X_train, X_test, y_train, y_test = train_test_split(
        X, y,
        test_size=test_size,
        random_state=42,
        stratify=y if len(np.unique(y)) > 1 else None,
    )
    print(f"  Test set: {len(X_test)} samples ({test_size*100:.0f}% of data)")

    # ── Run ONNX inference ────────────────────────────────────────────────────
    print("\n[3/4] Running inference on test set...")
    try:
        sess = rt.InferenceSession(str(model_path))
        input_name = sess.get_inputs()[0].name

        outputs = sess.run(
            ['probabilities'],
            {input_name: X_test.astype(np.float32)}
        )
        probs = np.array(outputs[0], dtype=np.float32) # shape: (n_samples, 5)

    except Exception as e:
        print(f"  FAILED: Inference error: {e}")
        return False

    # ── Verify output shape ───────────────────────────────────────────────────
    expected_shape = (len(X_test), 5)
    if probs.shape != expected_shape:
        print(
            f"  FAILED: Output shape is {probs.shape}, "
            f"expected {expected_shape}."
        )
        return False

    print(f"  Output shape: {probs.shape} ✓")

    # Predicted class = argmax of probabilities
    y_pred = np.argmax(probs, axis=1)

    # ── Overall accuracy ──────────────────────────────────────────────────────
    overall_acc = (y_pred == y_test).mean()
    print(f"\n[4/4] Accuracy results:")
    print(f"  Overall accuracy: {overall_acc*100:.1f}%", end="")

    if overall_acc < MIN_OVERALL_ACCURACY:
        print(f"  ✗  (minimum: {MIN_OVERALL_ACCURACY*100:.0f}%)")
    else:
        print(f"  ✓")

    # ── Per-class accuracy ────────────────────────────────────────────────────
    print(f"\n  Per-class results:")
    print(f"  {'Class':<18} {'Actual':>8} {'Predicted':>10} {'Accuracy':>10}  {'Status'}")
    print(f"  {'-'*18}  {'-'*8}  {'-'*10}  {'-'*10}  {'-'*10}")

    all_classes_pass = True
    classes_in_test  = np.unique(y_test)

    for internal in range(5):
        mask   = y_test == internal
        n_actual = mask.sum()

        if n_actual == 0:
            print(
                f"  {LABEL_NAMES[internal]:<18} {'0':>8} {'n/a':>10} {'n/a':>10}  "
                f"(not in test set)"
            )
            continue

        n_predicted_correct = (y_pred[mask] == internal).sum()
        class_acc = n_predicted_correct / n_actual
        n_predicted_as_this = (y_pred == internal).sum()

        status = '✓'
        if class_acc < MIN_CLASS_ACCURACY:
            status = '✗  COLLAPSE'
            all_classes_pass = False

        print(
            f"  {LABEL_NAMES[internal]:<18} {n_actual:>8} "
            f"{n_predicted_as_this:>10} {class_acc*100:>9.1f}%  {status}"
        )

    # ── Confidence distribution ───────────────────────────────────────────────
    # Check that the model isn't just outputting uniform probabilities (0.2 each)
    # which would mean it learned nothing
    max_probs   = probs.max(axis=1)
    avg_max_prob = max_probs.mean()
    print(f"\n  Average max probability per prediction: {avg_max_prob:.3f}")

    if avg_max_prob < 0.35:
        print(
            "  WARNING: Model is very uncertain on average. "
            "It may not have learned much."
        )
        print(
            "  Consider collecting more samples (especially for "
            "underrepresented labels)."
        )
    else:
        print("  Confidence looks healthy ✓")

    # ── Confusion matrix (compact) ────────────────────────────────────────────
    print(f"\n  Confusion matrix (rows=actual, cols=predicted):")
    cm = confusion_matrix(y_test, y_pred, labels=list(range(5)))
    header = f"  {'':15}" + "".join(f"  {INTERNAL_TO_LABEL[i]:>4}" for i in range(5))
    print(header)
    for i, row in enumerate(cm):
        label_str = f"  {LABEL_NAMES[i]:<15}"
        row_str   = "".join(f"  {v:>4}" for v in row)
        print(label_str + row_str)

    return all_classes_pass and overall_acc >= MIN_OVERALL_ACCURACY


def main():
    print("=" * 60)
    print("  Crypto Scanner — ONNX Model Validation")
    print("=" * 60)

    # ── Check model file exists ───────────────────────────────────────────────
    if not MODEL_PATH.exists():
        print(f"\n  ERROR: Model not found at {MODEL_PATH}")
        print(f"  Run train.py first.")
        return

    file_size_kb = MODEL_PATH.stat().st_size / 1024
    print(f"\n  Model: {MODEL_PATH} ({file_size_kb:.1f} KB)")

    # ── Check data file exists ────────────────────────────────────────────────
    if not DATA_PATH.exists():
        print(f"\n  ERROR: Training data not found at {DATA_PATH}")
        print(f"  Download it from Telegram (/export_training_data) first.")
        return

    # ── Run checks ────────────────────────────────────────────────────────────
    structure_ok = check_model_structure(MODEL_PATH)
    if not structure_ok:
        print("\n" + "=" * 60)
        print("  VALIDATION FAILED — do not upload this model.")
        print("  Fix the issues above and retrain.")
        print("=" * 60)
        return

    # Load data for inference validation
    print("\n  Loading data for inference test...")
    try:
        X, y, _ = load_training_data(DATA_PATH)
    except Exception as e:
        print(f"  ERROR loading data: {e}")
        return

    inference_ok = run_inference_validation(MODEL_PATH, X, y)

    # ── Final verdict ─────────────────────────────────────────────────────────
    print("\n" + "=" * 60)
    if inference_ok and structure_ok:
        print("  VALIDATION PASSED ✓")
        print("")
        print("  Safe to upload:")
        print(f"    {MODEL_PATH} → production models/model.onnx")
        print("")
        print("  After uploading, send /ml_reload to your Telegram bot.")
    else:
        print("  VALIDATION FAILED ✗")
        print("")
        print("  Do NOT upload this model.")
        print("  Collect more training samples and retrain.")
        print("")
        print("  Common causes:")
        print("    - Too few samples for some label classes")
        print("    - Feature vector mismatch (wrong EXPECTED_FEATURES)")
        print("    - Model collapsed to predicting one class only")
    print("=" * 60)


if __name__ == '__main__':
    main()
