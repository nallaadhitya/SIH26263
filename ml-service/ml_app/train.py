"""Explicit offline synthetic training. This module is never imported by API code."""
import hashlib
import json
from datetime import datetime, timezone

import joblib
import numpy as np
import sklearn
from sklearn.ensemble import IsolationForest
from sklearn.impute import SimpleImputer
from sklearn.metrics import confusion_matrix, precision_recall_fscore_support
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

from .features import feature_frame
from .model import AnomalyModel, model_directory
from .schema import FeatureRecord, INPUT_FEATURES, MODEL_FEATURES, MODEL_VERSION
from .synthetic import (
    TRAIN_SEED, EVALUATION_SEED, GENERATOR_VERSION, training_frame, evaluation_frame,
)


def records_from_frame(frame) -> list[FeatureRecord]:
    data = frame.loc[:, INPUT_FEATURES].astype(object).where(frame.loc[:, INPUT_FEATURES].notna(), None)
    return [FeatureRecord(**row) for row in data.to_dict(orient="records")]


def train_model() -> AnomalyModel:
    training = training_frame()
    frame = feature_frame(records_from_frame(training))
    pipeline = Pipeline([
        ("imputer", SimpleImputer(strategy="median", add_indicator=True, keep_empty_features=True)),
        ("scale", StandardScaler()),
        ("forest", IsolationForest(n_estimators=200, max_samples=256, contamination="auto",
                                   random_state=TRAIN_SEED, n_jobs=1)),
    ])
    pipeline.fit(frame)
    # Calibrated only on synthetic normal training data, never evaluation labels.
    threshold = float(np.quantile(-pipeline.score_samples(frame), 0.99))
    metadata = {
        "model_version": MODEL_VERSION, "algorithm": "IsolationForest",
        "input_features": INPUT_FEATURES, "features": MODEL_FEATURES,
        "threshold": threshold, "decision_rule": "review_flag = anomaly_score >= threshold",
        "score_definition": "negative sklearn score_samples; higher means more unusual, not a probability",
        "training_data_source": "synthetic_demo_only", "generator_version": GENERATOR_VERSION,
        "training_seed": TRAIN_SEED, "evaluation_seed": EVALUATION_SEED,
        "training_rows": len(training), "threshold_training_quantile": 0.99,
        "configuration": {"n_estimators": 200, "max_samples": 256, "random_state": TRAIN_SEED,
                          "contamination": "auto", "n_jobs": 1},
        "preprocessing": {
            "count_transform": "log1p", "imputation": "training_median",
            "missing_indicators": True, "scaling": "training_StandardScaler",
            "transformed_features": pipeline.named_steps["imputer"].get_feature_names_out(MODEL_FEATURES).tolist(),
        },
        "sklearn_version": sklearn.__version__,
        "training_sha256": hashlib.sha256(training.to_csv(index=False).encode()).hexdigest(),
        "limitations": ["Synthetic demonstration only; no real-world performance claims",
                        "Flags require human review; not fraud, noncompliance, or APAAR verification",
                        "Ratio is correlated with capacity; not independent compliance evidence",
                        "No feature-level causal explanation or probability calibration"],
    }
    return AnomalyModel(pipeline, metadata)


def evaluate_model(model: AnomalyModel) -> dict:
    evaluation = evaluation_frame()
    records = records_from_frame(evaluation)
    # Offline evaluation is allowed more than the API's 100-row request limit.
    predictions = model.predict(records)
    labels = evaluation["label"].to_numpy()
    flags = np.array([result["review_flag"] for result in predictions["results"]], dtype=int)
    precision, recall, f1, _ = precision_recall_fscore_support(labels, flags, average="binary", zero_division=0)
    return {"source": "synthetic_demo_evaluation", "rows": len(evaluation),
            "normal_rows": int((labels == 0).sum()), "unusual_rows": int((labels == 1).sum()),
            "precision": float(precision), "recall": float(recall), "f1": float(f1),
            "confusion_matrix": confusion_matrix(labels, flags, labels=[0, 1]).tolist(),
            "matrix_order": "rows=true normal/unusual; columns=predicted normal/review",
            "evaluation_seed": EVALUATION_SEED,
            "evaluation_sha256": hashlib.sha256(evaluation.to_csv(index=False).encode()).hexdigest(),
            "threshold": model.metadata["threshold"],
            "limitations": "Labels encode deliberately extreme synthetic examples, not real-world outcomes. No threshold tuning on evaluation data."}


def main() -> None:
    directory = model_directory()
    directory.mkdir(parents=True, exist_ok=True)
    model = train_model()
    metrics = evaluate_model(model)
    artifact = directory / "model.joblib"
    joblib.dump(model.pipeline, artifact)
    manifest = {**model.metadata, "trained_at": datetime.now(timezone.utc).isoformat(),
                "artifact_sha256": hashlib.sha256(artifact.read_bytes()).hexdigest()}
    (directory / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    (directory / "evaluation.json").write_text(json.dumps(metrics, indent=2), encoding="utf-8")
    training_frame().to_csv(directory / "synthetic-training.csv", index=False)
    evaluation_frame().to_csv(directory / "synthetic-evaluation.csv", index=False)
    print(json.dumps(metrics, indent=2))


if __name__ == "__main__":
    main()
