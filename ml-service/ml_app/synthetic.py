"""Versioned synthetic distributions, not observations of real students."""
import numpy as np
import pandas as pd

from .schema import INPUT_FEATURES

TRAIN_SEED = 42
EVALUATION_SEED = 2026
TRAIN_SIZE = 800
GENERATOR_VERSION = "fictional-aggregate-generator-1"


def normal_frame(size: int, seed: int) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    frame = pd.DataFrame({
        "active_record_count": np.clip(rng.lognormal(np.log(80), 0.30, size).round(), 10, 250).astype(int),
        "intake_ratio": np.clip(rng.normal(0.72, 0.13, size), 0.15, 1.1),
        "year_over_year_change": np.clip(rng.normal(0.03, 0.10, size), -0.35, 0.40),
        "admission_year_concentration": rng.uniform(0.60, 1.0, size),
    }, columns=INPUT_FEATURES)
    for column in INPUT_FEATURES[1:]:
        frame.loc[rng.random(size) < 0.10, column] = np.nan
    return frame


def training_frame() -> pd.DataFrame:
    return normal_frame(TRAIN_SIZE, TRAIN_SEED)


def evaluation_frame() -> pd.DataFrame:
    """Labels describe intentionally generated unusual examples, not fraud."""
    normal = normal_frame(200, EVALUATION_SEED)
    normal["label"] = 0
    rng = np.random.default_rng(EVALUATION_SEED + 1)
    unusual = pd.DataFrame({
        "active_record_count": rng.integers(1500, 6000, 60),
        "intake_ratio": rng.uniform(3.0, 9.0, 60),
        "year_over_year_change": rng.uniform(1.0, 4.0, 60),
        "admission_year_concentration": rng.uniform(0.05, 0.25, 60),
        "label": 1,
    })
    return pd.concat([normal, unusual], ignore_index=True)
