# ml/evaluate.py
# Phase 1 — Chronological ML evaluation CLI (measurement only)
# Production train.py / ONNX / trading behavior are NOT changed.
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

import numpy as np

from chronological import chronological_split, count_boundary_ties, time_range_summary
from labels import ALL_FORMULATIONS, FORMULATION_FIVE, class_counts, class_proportions
from metrics_report import metrics_to_markdown

# Re-export for tests: from evaluate import fit_predict, make_synthetic_frame
from evaluate_lib import fit_predict, make_synthetic_frame  # noqa: F401
from evaluate_lib import (
    INFORMATION_CONDITIONS,
    EVAL_XGB_PARAMS,
    RANDOM_SEED,
    REPORT_DIR,
    TrainingFrame,
    _find_data_path,
    evaluate_condition,
    leakage_audit_features,
    load_training_frame,
)
from utils import FEATURE_NAMES
from labels import LabelFormulation


def build_report(
    frame: TrainingFrame,
    split,
    results: List[Dict[str, Any]],
    data_source: str,
    is_fixture: bool,
) -> tuple:
    ts_all = time_range_summary(frame.closed_at, np.arange(len(frame.closed_at)))
    ts_train = time_range_summary(frame.closed_at, split.train_idx)
    ts_val = time_range_summary(frame.closed_at, split.val_idx)
    ts_test = time_range_summary(frame.closed_at, split.test_idx)
    ties = count_boundary_ties(frame.closed_at, split)

    native_counts = {int(k): int(v) for k, v in zip(*np.unique(frame.y_native, return_counts=True))}
    symbols = sorted(set(frame.symbols.tolist())) if frame.symbols is not None else []
    sides = {}
    if frame.sides is not None:
        for s in frame.sides:
            sides[str(s)] = sides.get(str(s), 0) + 1

    payload: Dict[str, Any] = {
        "phase": 1,
        "title": "Phase 1 — Measurement & ML Validation",
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "data_source": data_source,
        "is_fixture": is_fixture,
        "result_kind": "fixture_only" if is_fixture else "real_training_export",
        "random_seed": RANDOM_SEED,
        "dataset": {
            "n": int(len(frame.X)),
            "n_features": int(frame.X.shape[1]),
            "feature_names": FEATURE_NAMES,
            "symbols": symbols,
            "sides": sides,
            "sorted_chronologically": frame.sorted_chronologically,
            "time_range": ts_all,
            "native_label_counts": native_counts,
            "five_class_counts": class_counts(frame.y_internal, 5),
            "five_class_proportions": class_proportions(frame.y_internal, 5),
        },
        "split": {
            "train_ratio": split.train_ratio,
            "val_ratio": split.val_ratio,
            "test_ratio": split.test_ratio,
            "train": ts_train,
            "validation": ts_val,
            "test": ts_test,
            "boundary_ties": ties,
        },
        "model_config": EVAL_XGB_PARAMS,
        "label_mappings": {
            "five_class": "native -2..+2 → internal 0..4 (repository default)",
            "four_class": "disaster=-2→0, loss=-1→1, neutral=0→2, win=+1|+2→3",
            "three_class": "loss=-2|-1→0, neutral=0→1, win=+1|+2→2",
        },
        "information_conditions": INFORMATION_CONDITIONS,
        "ml_only_limitation": (
            "Pure ML-only cannot be isolated as a feature subset. Production ML "
            "consumes all 33 features (technical + history + identity) and emits "
            "label/confidence. None of the 33 features is an ML model output. "
            "Production Technical+ML is score-level fusion (buyScore/sellScore + "
            "ML bonus) which is not stored in the training CSV. Closest valid "
            "comparison: technical_only vs full_feature_ml (production ML inputs)."
        ),
        "leakage_audit_features": leakage_audit_features(),
        "leakage_audit_process": [
            "Export ordered DESC by closed_at; evaluation sorts ASC (stable mergesort).",
            "Split 60/20/20 chronological; model.fit uses only train indices.",
            "Final test never used for fit, formulation selection, or hyperparameter tuning.",
            "No scaler/imputer fitted on full data; features pre-normalized at export.",
            "Hyperparameters fixed (EVAL_XGB_PARAMS, seed=42); not tuned on test.",
            "Production train.py still fits full dataset for ONNX; unchanged.",
            "Equal closed_at: stable order; boundary_ties recorded if partition edge shares ms.",
        ],
        "results": results,
        "limitations": [],
        "conclusions": [],
    }

    lim = payload["limitations"]
    if is_fixture:
        lim.append(
            "Results are from a synthetic fixture, not production simulations. "
            "Not strategy evidence."
        )
    neutral_n = payload["dataset"]["five_class_counts"].get(2, 0)
    if neutral_n < 10:
        lim.append(
            f"Neutral class has only {neutral_n} samples overall — "
            "conclusions for neutral are not statistically reliable."
        )
    lim.append(payload["ml_only_limitation"])
    if ties["train_val_boundary_same_ts"] or ties["val_test_boundary_same_ts"]:
        lim.append(f"Boundary timestamp ties: {ties}")

    for r in results:
        for split_name in ("validation", "test"):
            m = r[split_name]
            if m.get("unreliable_classes") or m.get("missing_classes"):
                lim.append(
                    f"{r['formulation']}/{r['information_condition']}/{split_name}: "
                    f"missing={m.get('missing_classes')} unreliable={m.get('unreliable_classes')}"
                )

    conclusions = payload["conclusions"]
    conclusions.append(
        "Primary evaluation is chronological; final test was unseen during fitting."
    )
    conclusions.append(
        "Pure ML-only feature subset is not supported by the architecture; "
        "see ml_only_limitation."
    )
    conclusions.append(
        "Severe class imbalance (especially neutral) is quantified; "
        "raw accuracy alone is insufficient."
    )

    five_tech = next(
        (r for r in results
         if r["formulation"] == "five_class" and r["information_condition"] == "technical_only"),
        None,
    )
    five_full = next(
        (r for r in results
         if r["formulation"] == "five_class" and r["information_condition"] == "full_feature_ml"),
        None,
    )
    if five_tech and five_full:
        t_f1, f_f1 = five_tech["test"]["macro_f1"], five_full["test"]["macro_f1"]
        t_ba, f_ba = five_tech["test"]["balanced_accuracy"], five_full["test"]["balanced_accuracy"]
        conclusions.append(
            f"Five-class TEST macro_f1: technical_only={t_f1:.4f}, full_feature_ml={f_f1:.4f}."
        )
        conclusions.append(
            f"Five-class TEST balanced_accuracy: technical_only={t_ba:.4f}, full_feature_ml={f_ba:.4f}."
        )
        delta = f_f1 - t_f1
        if abs(delta) < 0.02:
            conclusions.append(
                "No material macro-F1 lift of full_feature_ml over technical_only "
                "on this test partition (|Δ|<0.02)."
            )
        elif delta > 0:
            conclusions.append(
                "full_feature_ml shows higher test macro-F1 than technical_only; "
                "provisional pending more data / walk-forward."
            )
        else:
            conclusions.append(
                "full_feature_ml shows lower test macro-F1 than technical_only "
                "on this partition."
            )

    md: List[str] = []
    md.append("# Phase 1 — Measurement & ML Validation Report")
    md.append("")
    md.append(f"Generated: `{payload['generated_at']}`")
    md.append(f"Data source: `{data_source}`")
    md.append(f"Result kind: **{payload['result_kind']}**")
    md.append(f"Fixture: **{is_fixture}** | Seed: `{RANDOM_SEED}`")
    md.append("")
    md.append("## Dataset")
    md.append("")
    md.append(f"- Samples: **{payload['dataset']['n']}**")
    md.append(f"- Features: **{payload['dataset']['n_features']}**")
    md.append(f"- Symbols: `{symbols}`")
    md.append(f"- Sides: `{sides}`")
    md.append(f"- Chronologically sorted: **{frame.sorted_chronologically}**")
    md.append(f"- Time range: `{ts_all.get('t_min_iso')}` → `{ts_all.get('t_max_iso')}`")
    md.append("")
    md.append("### Native label counts (-2..+2)")
    md.append("")
    md.append("| native | count |")
    md.append("|-------:|------:|")
    for lab in sorted(native_counts.keys()):
        md.append(f"| {lab:+d} | {native_counts[lab]} |")
    md.append("")
    md.append("### Five-class (mapped) distribution")
    md.append("")
    md.append("| class | count | proportion |")
    md.append("|-------|------:|-----------:|")
    fc = payload["dataset"]["five_class_counts"]
    fp = payload["dataset"]["five_class_proportions"]
    for i in range(5):
        md.append(
            f"| {FORMULATION_FIVE.class_names[i]} | {fc.get(i, 0)} | {fp.get(i, 0):.3f} |"
        )
    md.append("")
    md.append("## Chronological split (60 / 20 / 20)")
    md.append("")
    for name, block in (("train", ts_train), ("validation", ts_val), ("test", ts_test)):
        md.append(
            f"- **{name}**: n={block['n']}, `{block.get('t_min_iso')}` → `{block.get('t_max_iso')}`"
        )
    md.append(f"- Boundary ties: `{ties}`")
    md.append("")
    md.append("## Information conditions")
    md.append("")
    md.append(payload["ml_only_limitation"])
    md.append("")
    for k, v in INFORMATION_CONDITIONS.items():
        md.append(f"- **{v['role']}** (`{k}`): {v['description']}")
    md.append("")
    md.append("## Label mappings")
    md.append("")
    for k, v in payload["label_mappings"].items():
        md.append(f"- **{k}**: {v}")
    md.append("")
    md.append("## Leakage audit (process)")
    md.append("")
    for item in payload["leakage_audit_process"]:
        md.append(f"- {item}")
    md.append("")
    md.append("## Model configuration (evaluation artifacts only)")
    md.append("")
    md.append("```json")
    md.append(json.dumps(EVAL_XGB_PARAMS, indent=2))
    md.append("```")
    md.append("")
    md.append(
        "> These models are **not** production ONNX exports. "
        "`train.py` remains the production training entrypoint."
    )
    md.append("")
    md.append("## Results")
    md.append("")
    md.append(
        "Validation metrics are diagnostic only. "
        "**Final conclusions use the TEST partition.**"
    )
    md.append("")
    for r in results:
        title = (
            f"{r['formulation']} / {r['information_condition']} "
            f"({r['n_features']} features) — {r['role']}"
        )
        md.append(f"## {title}")
        md.append("")
        md.append(
            f"Train counts: `{r['train_class_counts']}`  \n"
            f"Val counts: `{r['val_class_counts']}`  \n"
            f"Test counts: `{r['test_class_counts']}`"
        )
        md.append("")
        md.append(metrics_to_markdown(r["validation"], f"VALIDATION — {title}", r["class_names"]))
        md.append(metrics_to_markdown(r["test"], f"TEST — {title}", r["class_names"]))

    md.append("## Limitations")
    md.append("")
    for item in lim:
        md.append(f"- {item}")
    md.append("")
    md.append("## Conclusions")
    md.append("")
    for item in conclusions:
        md.append(f"- {item}")
    md.append("")
    md.append("---")
    md.append("Phase 1 only — no strategy, entry, exit, or production ML gating changes.")
    md.append("")
    return "\n".join(md), payload


def run_evaluation(data_path, use_fixture: bool) -> int:
    if use_fixture:
        print("Using synthetic fixture data (smoke / CI).")
        frame = make_synthetic_frame()
        data_source = "synthetic_fixture"
        is_fixture = True
    else:
        if data_path is None:
            print(
                "ERROR: No training CSV found.\n"
                "Place export at ml/data/training_export.csv or pass --data PATH.\n"
                "Or run with --fixture for synthetic smoke evaluation."
            )
            return 1
        frame = load_training_frame(data_path, sort_chronologically=True)
        data_source = str(data_path)
        is_fixture = False
        if np.all(frame.closed_at == 0):
            print(
                "WARNING: All closed_at values are 0. Chronological order "
                "degrades to original row order after sort."
            )

    n = len(frame.X)
    split = chronological_split(n, timestamps=frame.closed_at)
    print(f"Split: train={split.train_size}, val={split.val_size}, test={split.test_size}")

    results: List[Dict[str, Any]] = []
    for formulation in ALL_FORMULATIONS:
        for cond_name, cond in INFORMATION_CONDITIONS.items():
            print(f"Evaluating {formulation.name} / {cond_name}...")
            r = evaluate_condition(
                frame, split, formulation, cond_name, cond["indices"]
            )
            results.append(r)
            print(
                f"  TEST accuracy={r['test']['accuracy']:.3f} "
                f"balanced_acc={r['test']['balanced_accuracy']:.3f} "
                f"macro_f1={r['test']['macro_f1']:.3f}"
            )

    md, payload = build_report(frame, split, results, data_source, is_fixture)
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    md_path = REPORT_DIR / "PHASE1_EVALUATION.md"
    json_path = REPORT_DIR / "PHASE1_EVALUATION.json"
    md_path.write_text(md, encoding="utf-8")
    json_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"\nWrote {md_path}")
    print(f"Wrote {json_path}")
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(description="Phase 1 chronological ML evaluation")
    parser.add_argument("--data", type=str, default=None)
    parser.add_argument("--fixture", action="store_true")
    args = parser.parse_args()
    data_path = _find_data_path(args.data) if not args.fixture else None
    if not args.fixture and args.data and data_path is None:
        print(f"ERROR: --data path not found: {args.data}")
        sys.exit(1)
    sys.exit(run_evaluation(data_path, use_fixture=args.fixture))


if __name__ == "__main__":
    main()
