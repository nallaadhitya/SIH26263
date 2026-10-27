"""Training-fitted numeric preprocessing; inference never calls fit."""
import numpy as np
import pandas as pd

from .schema import FeatureRecord, INPUT_FEATURES, MODEL_FEATURES


def feature_frame(records: list[FeatureRecord]) -> pd.DataFrame:
    frame = pd.DataFrame([record.model_dump() for record in records], columns=INPUT_FEATURES)
    frame["log_active_record_count"] = np.log1p(frame.pop("active_record_count"))
    return frame.loc[:, MODEL_FEATURES].astype(float)
