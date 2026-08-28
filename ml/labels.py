# ml/labels.py — Phase 1 label formulations (evaluation only)
from __future__ import annotations
from dataclasses import dataclass
from typing import Dict, List, Mapping
import numpy as np

FIVE_CLASS_NAMES = {0: "disaster", 1: "loss", 2: "neutral", 3: "good", 4: "monster"}
# Four-class: keep disaster distinct; pool +1/+2 as win
FOUR_CLASS_FROM_NATIVE = {-2: 0, -1: 1, 0: 2, 1: 3, 2: 3}
FOUR_CLASS_NAMES = {0: "disaster", 1: "loss", 2: "neutral", 3: "win"}
# Three-class: loss / neutral / win
THREE_CLASS_FROM_NATIVE = {-2: 0, -1: 0, 0: 1, 1: 2, 2: 2}
THREE_CLASS_NAMES = {0: "loss", 1: "neutral", 2: "win"}

@dataclass(frozen=True)
class LabelFormulation:
    name: str
    n_classes: int
    class_names: Mapping[int, str]
    from_native: Mapping[int, int]

    def map_native_array(self, native_y: np.ndarray) -> np.ndarray:
        out = np.empty(len(native_y), dtype=np.int32)
        for i, v in enumerate(native_y.astype(int)):
            if v not in self.from_native:
                raise ValueError(f"Unexpected native label {v}")
            out[i] = self.from_native[v]
        return out

    def map_internal_five(self, internal_y: np.ndarray) -> np.ndarray:
        native = internal_y.astype(int) - 2
        return self.map_native_array(native)

FORMULATION_FIVE = LabelFormulation("five_class", 5, FIVE_CLASS_NAMES, {-2: 0, -1: 1, 0: 2, 1: 3, 2: 4})
FORMULATION_FOUR = LabelFormulation("four_class", 4, FOUR_CLASS_NAMES, FOUR_CLASS_FROM_NATIVE)
FORMULATION_THREE = LabelFormulation("three_class", 3, THREE_CLASS_NAMES, THREE_CLASS_FROM_NATIVE)
ALL_FORMULATIONS: List[LabelFormulation] = [FORMULATION_FIVE, FORMULATION_FOUR, FORMULATION_THREE]

def class_counts(y: np.ndarray, n_classes: int) -> Dict[int, int]:
    counts = {i: 0 for i in range(n_classes)}
    if len(y) == 0:
        return counts
    unique, cnt = np.unique(y, return_counts=True)
    for u, c in zip(unique.tolist(), cnt.tolist()):
        if 0 <= int(u) < n_classes:
            counts[int(u)] = int(c)
    return counts

def class_proportions(y: np.ndarray, n_classes: int) -> Dict[int, float]:
    n = max(len(y), 1)
    return {k: v / n for k, v in class_counts(y, n_classes).items()}
