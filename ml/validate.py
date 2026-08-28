# ml/validate.py
# Pre-upload sanity check for the trained ONNX model
#
# Phase 1: chronological hold-out (last 20% by closed_at) instead of
# sklearn train_test_split. Production ONNX is still trained on full data
# by train.py; use evaluate.py for true chronological train	o test metrics.
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
MIN_CLASS_ACCURACY = 0.05
MIN_OVERALL_ACCURACY = 0.35


def _resolve_data_path() -> Path:
    for p in DATA_CANDIDATES:
        if p.exists():
            return p
    raise FileNotFoundError(
        "Training data not found. Tried: "
        + ", ".join(str(p) for p in DATA_CANDIDATES)
    )


def check_model_structure(model_path: Path) -> bool:
    print("[1/4] Checking model structure...")
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
        print(f"  Input shape: {input_shape} \u2713  ({n_features} features)")
    except Exception as e:
        print(f"  WARNING: Could not read input shape: {e}")
    output_names = [o.name for o in model.graph.output]
    print(f"  Output nodes: {output_names}")
    if "probabilities" not in output_names:
        print("  FAILED: Expected output node 'probabilities' not found.")
        return False
    print("  Output node 'probabilities' found \u2713")
    return True


def run_inference_validation(model_path: Path, frame) -> bool:
    print("\n[2/4] Chronological split for validation...")
    n = len(frame.X)
    split = chronological_split(n, timestamps=frame.closed_at)
    X_test = frame.X[split.test_idx]
    y_test = frame.y_internal[split.test_idx]
    print(
        f"  Test set: {len(X_test)} samples "
        f"(last {split.test_ratio * 100:.0f}% chronologically)"
    )
    print(
        "  NOTE: Production ONNX is trained on full data; "
        "use evaluate.py for true chronological train\u2192test."
    )
    print("\n[3/4] Running inference on chronological test set...")
    try:
        sess = rt.InferenceSession(str(model_path))
        input_name = sess.get_inputs()[0].name
        outputs = sess.run(
            ["probabilities"], {input_name: X_test.astype(np.float32)}
        )
        probs = np.array(outputs[0], dtype=np.float32)
    except Exception as e:
        print(f"  FAILED: Inference error: {e}")
        return False
    if probs.shape != (len(X_test), 5):
        print(f"  FAILED: Output shape is {probs.shape}, expected {(len(X_test), 5)}.")
        return False
    print(f"  Output shape: {probs.shape} \u2713")
    y_pred = np.argmax(probs, axis=1)
    overall_acc = float((y_pred == y_test).mean()) if len(y_test) else 0.0
    print("\n[4/4] Accuracy results:")
    print(f"  Overall accuracy: {overall_acc * 100:.1f}%", end="")
    print(f"  {'\u2717' if overall_acc < MIN_OVERALL_ACCURACY else '\u2713'}")
    print("\n  Per-class results:")
    print(f"  {'Class':<18} {'Actual':>8} {'Predicted':>10} {'Accuracy':>10}  Status")
    all_ok = True
    for internal in range(5):
        mask = y_test == internal
        n_actual = int(mask.sum())
        if n_actual == 0:
            print(f"  {LABEL_NAMES[internal]:<18} {'0':>8} {'n/a':>10} {'n/a':>10}  (not in test)")
            continue
        class_acc = int((y_pred[mask] == internal).sum()) / n_actual
        n_pred = int((y_pred == internal).sum())
        status = "\u2713" if class_acc >= MIN_CLASS_ACCURACY else "\u2717  COLLAPSE"
        if class_acc < MIN_CLASS_ACCURACY:
            all_ok = False
        print(
            f"  {LABEL_NAMES[internal]:<18} {n_actual:>8} {n_pred:>10} "
            f"{class_acc * 100:>9.1f}%  {status}"
        )
    avg_max = float(probs.max(axis=1).mean()) if len(probs) else 0.0
    print(f"\n  Average max probability: {avg_max:.3f}")
    cm = confusion_matrix(y_test, y_pred, labels=list(range(5)))
    print("\n  Confusion matrix (rows=actual, cols=predicted):")
    header = f"  {'':15}" + "".join(f"  {INTERNAL_TO_LABEL[i]:>4}" for i in range(5))
    print(header)
    for i, row in enumerate(cm):
        print(f"  {LABEL_NAMES[i]:<15}" + "".join(f"  {v:>4}" for v in row))
    return all_ok and overall_acc >= MIN_OVERALL_ACCURACY


def main():
    print("=" * 60)
    print("  Crypto Scanner \u2014 ONNX Model Validation")
    print("=" * 60)
    if not MODEL_PATH.exists():
        print(f"\n  ERROR: Model not found at {MODEL_PATH}")
        return
    print(f"\n  Model: {MODEL_PATH} ({MODEL_PATH.stat().st_size / 1024:.1f} KB)")
    try:
        data_path = _resolve_data_path()
    except FileNotFoundError as e:
        print(f"\n  ERROR: {e}")
        return
    if not check_model_structure(MODEL_PATH):
        print("\n  VALIDATION FAILED \u2014 do not upload.")
        return
    print("\n  Loading data for chronological inference test...")
    try:
        frame = load_training_frame(data_path, sort_chronologically=True)
    except Exception as e:
        print(f"  ERROR loading data: {e}")
        return
    ok = run_inference_validation(MODEL_PATH, frame)
    print("\n" + "=" * 60)
    if ok:
        print("  VALIDATION PASSED \u2713")
        print(f"  Safe to upload: {MODEL_PATH} \u2192 production models/model.onnx")
        print("  For leakage-free metrics: python evaluate.py")
    else:
        print("  VALIDATION FAILED \u2717 \u2014 do not upload.")
    print("=" * 60)


if __name__ == "__main__":
    main()
