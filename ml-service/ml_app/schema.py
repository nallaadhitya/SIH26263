"""Strict, identifier-free feature contracts shared by training and inference."""
import math

from pydantic import BaseModel, ConfigDict, Field, field_validator

INPUT_FEATURES = [
    "active_record_count", "intake_ratio", "year_over_year_change",
    "admission_year_concentration",
]
MODEL_FEATURES = ["log_active_record_count", *INPUT_FEATURES[1:]]
MODEL_VERSION = "synthetic-isolation-forest-1.0.0"
MAX_BATCH = 100


class FeatureRecord(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    active_record_count: int = Field(strict=True, ge=0, le=100_000)
    intake_ratio: float | None = Field(default=None, ge=0, le=20)
    year_over_year_change: float | None = Field(default=None, ge=-1, le=20)
    admission_year_concentration: float | None = Field(default=None, ge=0, le=1)

    @field_validator(*INPUT_FEATURES[1:], mode="before")
    @classmethod
    def numeric_or_missing(cls, value: object) -> object:
        if value is not None and (
            isinstance(value, bool) or not isinstance(value, (int, float))
            or not math.isfinite(value)
        ):
            raise ValueError("Expected finite numeric value or null")
        return value


class PredictionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    records: list[FeatureRecord] = Field(min_length=1, max_length=MAX_BATCH)
