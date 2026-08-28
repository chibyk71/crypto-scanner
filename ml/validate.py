# ml/validate.py
# Pre-upload ONNX structure / inference smoke check
#
# Phase 1: This script is a COMPATIBILITY smoke check only.
# It does NOT provide genuine out-of-sample validation.
#
# The production ONNX model is trained on the FULL dataset by train.py.
# Running inference on a chronological last-20% slice is therefore NOT
# leakage-free hold-out evaluation — the model has already seen those rows.
#
# For genuine chronological train→test metrics, use:
#   python evaluate.py
#   python evaluate.py --fixture
from __future__ import annotations

import numpy as np
import onnx
import onnxruntime as rt
from pathlib import Path
from sklearn.metrics import confusion_matrix

from chronological import chronological_split
from utils import (
    EXPECTED_FEATURES,
    LABEL_NAMES,
    INTERNAL_TO_LABEL,
    load_training_frame,
)

DATA_CANDIDATES = [
    Path("data/training_export.csv"),
    Path("data/simulated_trades.csv"),
]
MODEL_PATH = Path("models/model.onnx")


def _resolve_data_path() -> Path:
    for p in DATA_CANDIDATES:
        if p.exists():
            return p
    raise FileNotFoundError(
        "Training data not found. Tried: "
        + ", ".join(str(p) for p in DATA_CANDIDATES)
    )


def check_model_structure(model_path: Path) -> bool:
    print("[1/3] Checking model structure...")
    try:
        model = onnx.load(str(model_path))
        onnx.checker.check_model(model)
        print("  ONNX file is valid.")
    except Exception as e:
        print(f"  FAILED: ONNX model is invalid: {e}")
        return False
    try:
        input_info = model.graph.input[0]
        input_shape = [d.dim_value for d in input_info.type.tensor_type.shape.dim]
        n_features = input_shape[1] if len(input_shape) > 1 else input_shape[0]
        if n_features != EXPECTED_FEATURES:
            print(
                f"  FAILED: Model expects {n_features} features, "
                f"but mlService.ts sends {EXPECTED_FEATURES}."
            )
            return False
        print(f"  Input shape: {input_shape}  ({n_features} features) OK")
    except Exception as e:
        print(f"  WARNING: Could not read input shape: {e}")
    output_names = [o.name for o in model.graph.output]
    print(f"  Output nodes: {output_names}")
    if "probabilities" not in output_names:
        print("  FAILED: Expected output node 'probabilities' not found.")
        return False
    print("  Output node 'probabilities' found OK")
    return True


def run_inference_smoke(model_path: Path, frame) -> bool:
    """Smoke-test ONNX inference. Metrics are NOT out-of-sample estimates."""
    print("\n[2/3] Inference smoke check (NOT out-of-sample validation)...")
    print(
        "  NOTE: Production ONNX is trained on the FULL dataset by train.py.\n"
        "  Any accuracy numbers below are in-sample / partially leaked and\n"
        "  must NOT be treated as hold-out performance.\n"
        "  Use evaluate.py for genuine chronological train→test metrics."
    )
    n = len(frame.X)
    split = chronological_split(n, timestamps=frame.closed_at)
    X_slice = frame.X[split.test_idx]
    y_slice = frame.y_internal[split.test_idx]
    print(f"  Running inference on {len(X_slice)} rows (structure smoke only)")

    try:
        sess = rt.InferenceSession(str(model_path))
        input_name = sess.get_inputs()[0].name
        outputs = sess.run(
            ["probabilities"], {input_name: X_slice.astype(np.float32)}
        )
        probs = np.array(outputs[0], dtype=np.float32)
    except Exception as e:
        print(f"  FAILED: Inference error: {e}")
        return False

    if probs.shape != (len(X_slice), 5):
        print(f"  FAILED: Output shape is {probs.shape}, expected {(len(X_slice), 5)}.")
        return False
    print(f"  Output shape: {probs.shape} OK")

    y_pred = np.argmax(probs, axis=1)
    overall_acc = float((y_pred == y_slice).mean()) if len(y_slice) else 0.0
    print("\n[3/3] Diagnostic accuracy (IN-SAMPLE / LEAKED — not hold-out):")
    print(f"  Overall accuracy (leaked): {overall_acc * 100:.1f}%")
    print("  Per-class (diagnostic only):")
    print(f"  {'Class':<18} {'Actual':>8} {'Predicted':>10} {'Accuracy':>10}")
    for internal in range(5):
        mask = y_slice == internal
        n_actual = int(mask.sum())
        if n_actual == 0:
            print(f"  {LABEL_NAMES[internal]:<18} {'0':>8} {'n/a':>10} {'n/a':>10}")
            continue
        class_acc = int((y_pred[mask] == internal).sum()) / n_actual
        n_pred = int((y_pred == internal).sum())
        print(
            f"  {LABEL_NAMES[internal]:<18} {n_actual:>8} {n_pred:>10} "
            f"{class_acc * 100:>9.1f}%"
        )
    avg_max = float(probs.max(axis=1).mean()) if len(probs) else 0.0
    print(f"\n  Average max probability: {avg_max:.3f}")
    cm = confusion_matrix(y_slice, y_pred, labels=list(range(5)))
    print("\n  Confusion matrix (rows=actual, cols=predicted) — diagnostic only:")
    header = f"  {'':15}" + "".join(f"  {INTERNAL_TO_LABEL[i]:>4}" for i in range(5))
    print(header)
    for i, row in enumerate(cm):
        print(f"  {LABEL_NAMES[i]:<15}" + "".join(f"  {v:>4}" for v in row))

    # Smoke check passes if inference ran and shape is correct — not on accuracy
    return True


def main():
    print("=" * 60)
    print("  Crypto Scanner — ONNX Structure / Inference Smoke Check")
    print("=" * 60)
    print()
    print("  This is NOT genuine out-of-sample validation.")
    print("  Production model is trained on the full dataset (train.py).")
    print("  For leakage-free chronological metrics: python evaluate.py")
    print()

    if not MODEL_PATH.exists():
        print(f"  ERROR: Model not found at {MODEL_PATH}")
        return

    print(f"  Model: {MODEL_PATH} ({MODEL_PATH.stat().st_size / 1024:.1f} KB)")

    structure_ok = check_model_structure(MODEL_PATH)
    if not structure_ok:
        print("\n" + "=" * 60)
        print("  STRUCTURE CHECK FAILED")
        print("  Do not upload — ONNX structure is incompatible.")
        print("=" * 60)
        return

    try:
        data_path = _resolve_data_path()
    except FileNotFoundError as e:
        print(f"\n  WARNING: {e}")
        print("  Structure check passed; skipping inference smoke (no data).")
        print("\n" + "=" * 60)
        print("  STRUCTURE CHECK PASSED (inference smoke skipped — no data)")
        print("  This is a format compatibility check only.")
        print("  It does NOT certify out-of-sample performance.")
        print("  For genuine chronological evaluation: python evaluate.py")
        print("=" * 60)
        return

    print("\n  Loading data for inference smoke...")
    try:
        frame = load_training_frame(data_path, sort_chronologically=True)
    except Exception as e:
        print(f"  ERROR loading data: {e}")
        print("\n" + "=" * 60)
        print("  STRUCTURE CHECK PASSED; inference smoke failed to load data")
        print("  This is a format compatibility check only.")
        print("=" * 60)
        return

    inference_ok = run_inference_smoke(MODEL_PATH, frame)

    print("\n" + "=" * 60)
    if structure_ok and inference_ok:
        print("  STRUCTURE + INFERENCE SMOKE PASSED")
        print("  ONNX format is compatible with mlService expectations.")
        print()
        print("  IMPORTANT:")
        print("  - This is NOT out-of-sample / hold-out validation.")
        print("  - The production model was trained on the full dataset.")
        print("  - Do NOT treat the diagnostic accuracy above as OOS performance.")
        print("  - For genuine chronological train→test metrics:")
        print("      python evaluate.py")
        print("      python evaluate.py --fixture")
    else:
        print("  SMOKE CHECK FAILED")
        print("  Fix structure/inference issues before uploading.")
    print("=" * 60)


if __name__ == "__main__":
    main()
