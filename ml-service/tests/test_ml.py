import hashlib
import json
from pathlib import Path
from unittest.mock import patch

import joblib
import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from ml_app.api import MAX_REQUEST_BYTES, create_app
from ml_app.features import feature_frame
from ml_app.model import load_model
from ml_app.schema import FeatureRecord, INPUT_FEATURES, MODEL_FEATURES, MODEL_VERSION
from ml_app.synthetic import TRAIN_SEED, EVALUATION_SEED, training_frame, evaluation_frame
from ml_app.train import train_model, evaluate_model

KEY = __import__("secrets").token_hex(32)
HEADERS = {"X-ML-Service-Key": KEY}
NORMAL = {"active_record_count": 80, "intake_ratio": 0.72,
          "year_over_year_change": 0.03, "admission_year_concentration": 0.8}
UNUSUAL = {"active_record_count": 4000, "intake_ratio": 5.0,
           "year_over_year_change": 2.0, "admission_year_concentration": 0.1}


@pytest.fixture(scope="session")
def model():
    return train_model()


@pytest.fixture()
def client(model):
    with TestClient(create_app(model, KEY)) as test_client:
        yield test_client


@pytest.mark.parametrize("changes", [
    {"active_record_count": -1}, {"active_record_count": 100001}, {"active_record_count": True},
    {"active_record_count": "80"}, {"intake_ratio": "0.8"}, {"intake_ratio": 21},
    {"year_over_year_change": -2}, {"admission_year_concentration": 1.1},
    {"intake_ratio": float("nan")}, {"intake_ratio": float("inf")},
    {"intake_ratio": True}, {"apaarId": "DEMO-APAAR-0001"},
])
def test_strict_schema(changes):
    with pytest.raises(ValidationError):
        FeatureRecord(**{**NORMAL, **changes})


def test_feature_ordering_and_log_transform():
    record = FeatureRecord(**dict(reversed(list(NORMAL.items()))))
    frame = feature_frame([record])
    assert list(frame.columns) == MODEL_FEATURES
    assert frame.iloc[0, 0] == pytest.approx(np.log1p(80))


def test_missing_values_are_imputed_using_training_only(model):
    before = model.pipeline.named_steps["imputer"].statistics_.copy()
    scale = model.pipeline.named_steps["scale"].mean_.copy()
    with patch.object(model.pipeline, "fit", side_effect=AssertionError("Inference must not fit")):
        result = model.predict([FeatureRecord(active_record_count=80)])
    assert np.isfinite(result["results"][0]["anomaly_score"])
    assert result["results"][0]["missing_features"] == INPUT_FEATURES[1:]
    np.testing.assert_equal(before, model.pipeline.named_steps["imputer"].statistics_)
    np.testing.assert_equal(scale, model.pipeline.named_steps["scale"].mean_)


def test_training_is_repeatable_and_never_uses_evaluation_labels(model):
    with patch("ml_app.train.evaluation_frame", side_effect=AssertionError("No evaluation during training")):
        repeated = train_model()
    records = [FeatureRecord(**NORMAL), FeatureRecord(**UNUSUAL)]
    assert repeated.metadata == model.metadata
    assert repeated.predict(records) == model.predict(records)


def test_training_and_labelled_evaluation_are_separate():
    training = training_frame()
    evaluation = evaluation_frame()
    assert TRAIN_SEED != EVALUATION_SEED
    assert "label" not in training.columns
    assert set(evaluation["label"]) == {0, 1}
    assert len(pd.merge(training, evaluation, on=INPUT_FEATURES, how="inner")) == 0
    assert training.equals(training_frame())
    assert evaluation.equals(evaluation_frame())


def test_normal_and_deliberately_unusual_examples(model):
    normal, unusual = model.predict([FeatureRecord(**NORMAL), FeatureRecord(**UNUSUAL)])["results"]
    assert normal["review_flag"] is False
    assert unusual["review_flag"] is True
    assert unusual["anomaly_score"] > normal["anomaly_score"]


def test_synthetic_metrics_have_explicit_labels_and_matrix_order(model):
    metrics = evaluate_model(model)
    assert metrics["source"] == "synthetic_demo_evaluation"
    assert metrics["normal_rows"] == 200 and metrics["unusual_rows"] == 60
    assert sum(sum(row) for row in metrics["confusion_matrix"]) == 260
    for key in ["precision", "recall", "f1"]:
        assert 0 <= metrics[key] <= 1
    assert metrics["threshold"] == model.metadata["threshold"]


def test_health_and_private_metadata(client):
    assert client.get("/health").json() == {"status": "ok", "model_available": True}
    assert client.get("/model/info").status_code == 401
    info = client.get("/model/info", headers=HEADERS)
    assert info.status_code == 200
    assert info.json()["model_version"] == MODEL_VERSION
    assert info.json()["features"] == MODEL_FEATURES
    assert info.json()["preprocessing"]["transformed_features"][:4] == MODEL_FEATURES
    assert len(info.json()["preprocessing"]["transformed_features"]) == 7
    assert info.json()["training_data_source"] == "synthetic_demo_only"


def test_prediction_contract_and_internal_authentication(client):
    body = {"records": [NORMAL, UNUSUAL]}
    assert client.post("/predict", json=body).status_code == 401
    assert client.post("/predict", json=body, headers={"X-ML-Service-Key": "wrong"}).status_code == 401
    response = client.post("/predict", json=body, headers=HEADERS)
    assert response.status_code == 200
    assert response.json()["source"] == "ml_anomaly"
    assert response.json()["results"][1]["review_flag"] is True
    assert response.headers["cache-control"] == "no-store"
    assert client.post("/predict", json=body, headers={**HEADERS, "Origin": "http://localhost:5000"}).status_code == 403


@pytest.mark.parametrize("body", [
    {"records": []}, {"records": [NORMAL] * 101}, {"records": [{}]},
    {"records": [{**NORMAL, "studentName": "Fictional Private Name"}]},
    {"records": [NORMAL], "train": True}, {"records": "wrong"},
])
def test_safe_request_errors(client, body):
    response = client.post("/predict", json=body, headers=HEADERS)
    assert response.status_code == 422
    assert response.json() == {"error": "Invalid feature request"}


def test_malformed_json_and_size_limits(client):
    assert client.post("/predict", content=b"{invalid", headers=HEADERS).status_code == 422
    response = client.post("/predict", content=b"x" * (MAX_REQUEST_BYTES + 1), headers=HEADERS)
    assert response.status_code == 413
    # Actual bytes remain bounded even if Content-Length is false.
    response = client.post("/predict", content=b"x" * (MAX_REQUEST_BYTES + 1),
                           headers={**HEADERS, "Content-Length": "0"})
    assert response.status_code == 413


def test_missing_model_and_key_fail_closed(monkeypatch):
    with patch("ml_app.api.load_model", side_effect=ValueError("Missing artifact")):
        with TestClient(create_app(None, KEY)) as client:
            assert client.get("/health").status_code == 503
            assert client.post("/predict", json={"records": [NORMAL]}, headers=HEADERS).status_code == 503
    with TestClient(create_app(None, "")) as client:
        assert client.get("/health").status_code == 503
        assert client.post("/predict", json={"records": [NORMAL]}, headers=HEADERS).status_code == 503


def test_internal_errors_do_not_echo_data_or_stack(model):
    with TestClient(create_app(model, KEY), raise_server_exceptions=False) as client:
        with patch.object(model.pipeline, "score_samples", side_effect=RuntimeError("Sensitive internal path")):
            response = client.post("/predict", json={"records": [NORMAL]}, headers=HEADERS)
        assert response.status_code == 500
        assert response.json() == {"error": "ML inference failed"}


def test_trusted_artifact_loading_and_integrity(model, tmp_path):
    # pytest.ini places tmp_path inside this project's ignored test directory.
    assert Path(__file__).resolve().parents[1] in tmp_path.resolve().parents
    artifact = tmp_path / "model.joblib"
    joblib.dump(model.pipeline, artifact)
    metadata = {**model.metadata, "artifact_sha256": hashlib.sha256(artifact.read_bytes()).hexdigest()}
    (tmp_path / "manifest.json").write_text(json.dumps(metadata), encoding="utf-8")
    loaded = load_model(tmp_path)
    assert loaded.predict([FeatureRecord(**NORMAL)]) == model.predict([FeatureRecord(**NORMAL)])
    artifact.write_bytes(b"corrupted")
    with pytest.raises(ValueError, match="integrity"):
        load_model(tmp_path)
