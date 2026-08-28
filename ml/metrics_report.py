# ml/metrics_report.py
# Phase 1 — Imbalance-aware classification metrics (safe for rare/missing classes)
from __future__ import annotations

from typing import Any, Dict, List, Mapping, Optional

import numpy as np
from sklearn.metrics import (
    accuracy_score,
    balanced_accuracy_score,
    confusion_matrix,
    f1_score,
    precision_recall_fscore_support,
)

MIN_RELIABLE_SUPPORT = 10


def safe_classification_metrics(
    y_true: np.ndarray,
    y_pred: np.ndarray,
    n_classes: int,
    class_names: Optional[Mapping[int, str]] = None,
) -> Dict[str, Any]:
    y_true = np.asarray(y_true, dtype=np.int32)
    y_pred = np.asarray(y_pred, dtype=np.int32)
    labels = list(range(n_classes))

    acc = float(accuracy_score(y_true, y_pred)) if len(y_true) else 0.0
    try:
        bal_acc = float(balanced_accuracy_score(y_true, y_pred, adjusted=False))
    except ValueError:
        bal_acc = 0.0
    try:
        macro_f1 = float(
            f1_score(y_true, y_pred, labels=labels, average="macro", zero_division=0)
        )
    except ValueError:
        macro_f1 = 0.0

    precision, recall, f1, support = precision_recall_fscore_support(
        y_true, y_pred, labels=labels, average=None, zero_division=0
    )
    cm = confusion_matrix(y_true, y_pred, labels=labels)
    pred_counts = {i: int((y_pred == i).sum()) for i in labels}
    true_counts = {i: int((y_true == i).sum()) for i in labels}
    unreliable = [i for i, c in true_counts.items() if 0 < c < MIN_RELIABLE_SUPPORT]
    missing = [i for i, c in true_counts.items() if c == 0]

    per_class: List[Dict[str, Any]] = []
    for i in labels:
        name = class_names.get(i, str(i)) if class_names is not None else str(i)
        per_class.append(
            {
                "class_id": i,
                "name": name,
                "precision": float(precision[i]),
                "recall": float(recall[i]),
                "f1": float(f1[i]),
                "support": int(support[i]),
                "predicted_count": pred_counts[i],
                "reliable": true_counts[i] >= MIN_RELIABLE_SUPPORT,
            }
        )

    return {
        "n": int(len(y_true)),
        "accuracy": acc,
        "balanced_accuracy": bal_acc,
        "macro_f1": macro_f1,
        "per_class": per_class,
        "confusion_matrix": cm.tolist(),
        "true_counts": true_counts,
        "pred_counts": pred_counts,
        "unreliable_classes": unreliable,
        "missing_classes": missing,
        "min_reliable_support": MIN_RELIABLE_SUPPORT,
    }


def metrics_to_markdown(
    metrics: Dict[str, Any],
    title: str,
    class_names: Optional[Mapping[int, str]] = None,
) -> str:
    lines = [f"### {title}", ""]
    lines.append(f"- n = {metrics['n']}")
    lines.append(f"- accuracy = {metrics['accuracy']:.4f}")
    lines.append(f"- balanced_accuracy = {metrics['balanced_accuracy']:.4f}")
    lines.append(f"- macro_f1 = {metrics['macro_f1']:.4f}")
    if metrics.get("missing_classes"):
        lines.append(f"- missing classes in y_true: {metrics['missing_classes']}")
    if metrics.get("unreliable_classes"):
        lines.append(
            f"- unreliable classes (support < {metrics['min_reliable_support']}): "
            f"{metrics['unreliable_classes']}"
        )
    lines.append("")
    lines.append("| class | support | precision | recall | f1 | predicted |")
    lines.append("|-------|--------:|----------:|-------:|---:|----------:|")
    for row in metrics["per_class"]:
        flag = "" if row["reliable"] else " *"
        lines.append(
            f"| {row['name']}{flag} | {row['support']} | "
            f"{row['precision']:.3f} | {row['recall']:.3f} | "
            f"{row['f1']:.3f} | {row['predicted_count']} |"
        )
    lines.append("")
    lines.append("Confusion matrix (rows=actual, cols=predicted):")
    lines.append("")
    cm = metrics["confusion_matrix"]
    header = "| actual \\ pred | " + " | ".join(str(i) for i in range(len(cm))) + " |"
    sep = "|---|" + "---|" * len(cm)
    lines.append(header)
    lines.append(sep)
    for i, row in enumerate(cm):
        name = class_names.get(i, str(i)) if class_names is not None else str(i)
        lines.append(f"| {name} | " + " | ".join(str(v) for v in row) + " |")
    lines.append("")
    return "\n".join(lines)
