"""Inference and trusted local model loading, independent of training code."""
import hashlib
import json
import os
from dataclasses import dataclass
from pathlib import Path

import joblib
import numpy as np
import sklearn
from sklearn.pipeline import Pipeline

from .features import feature_frame
from .schema import FeatureRecord, INPUT_FEATURES, MODEL_FEATURES, MODEL_VERSION

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_MODEL_DIR = PROJECT_ROOT / "ml-service" / "artifacts"


def model_directory() -> Path:
    configured = Path(os.getenv("ML_MODEL_DIR", "ml-service/artifacts"))
    result = (PROJECT_ROOT / configured).resolve()
    if configured.is_absolute() or not result.is_relative_to(PROJECT_ROOT / "ml-service"):
        raise ValueError("Model directory must be relative and inside ml-service")
    return result


@dataclass
class AnomalyModel:
    pipeline: Pipeline
    metadata: dict

    def predict(self, records: list[FeatureRecord]) -> dict:
        scores = -self.pipeline.score_samples(feature_frame(records))
        threshold = self.metadata["threshold"]
        results = [{"index": index, "anomaly_score": float(score),
                    "review_flag": bool(score >= threshold),
                    "missing_features": [name for name in INPUT_FEATURES[1:]
                                         if getattr(records[index], name) is None]}
                   for index, score in enumerate(scores)]
        if not np.isfinite(scores).all():
            raise ValueError("Nonfinite inference result")
        return {"model_version": MODEL_VERSION, "source": "ml_anomaly",
                "threshold": threshold, "results": results}


def load_model(directory: Path) -> AnomalyModel:
    """Only load artifacts created by the local offline trainer, never uploads.

    SHA-256 detects mismatch/corruption, not a malicious local OS user who can
    replace both files. joblib is pickle-based and must remain trusted input.
    """
    manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
    artifact = directory / "model.joblib"
    if hashlib.sha256(artifact.read_bytes()).hexdigest() != manifest["artifact_sha256"]:
        raise ValueError("Model integrity check failed")
    if (manifest["model_version"] != MODEL_VERSION
            or manifest["input_features"] != INPUT_FEATURES
            or manifest["features"] != MODEL_FEATURES
            or manifest["sklearn_version"] != sklearn.__version__):
        raise ValueError("Model contract/version mismatch")
    pipeline = joblib.load(artifact)
    return AnomalyModel(pipeline, manifest)
