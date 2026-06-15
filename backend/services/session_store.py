"""In-memory store for uploaded dataframes. A session can hold multiple
datasets (and joined results), keyed by dataset name."""
import re
import uuid
from dataclasses import dataclass, field

import pandas as pd


@dataclass
class Session:
    datasets: dict = field(default_factory=dict)  # name -> DataFrame
    profiles: dict = field(default_factory=dict)  # name -> profile dict
    active: str = ""  # most recently added/joined dataset


_sessions: dict[str, Session] = {}


def get_or_create(session_id: str | None = None) -> tuple[str, Session]:
    if session_id and session_id in _sessions:
        return session_id, _sessions[session_id]
    sid = uuid.uuid4().hex[:12]
    _sessions[sid] = Session()
    return sid, _sessions[sid]


def get_session(session_id: str) -> Session | None:
    return _sessions.get(session_id)


def add_dataset(session: Session, name: str, df: pd.DataFrame, profile: dict) -> str:
    name = re.sub(r"[^\w]+", "_", name).strip("_") or "data"
    base, i = name, 2
    while name in session.datasets:
        name = f"{base}_{i}"
        i += 1
    session.datasets[name] = df
    session.profiles[name] = profile
    session.active = name
    return name


def dataset_summary(session: Session) -> list[dict]:
    return [
        {
            "name": name,
            "rows": int(df.shape[0]),
            "columns": [str(c) for c in df.columns],
        }
        for name, df in session.datasets.items()
    ]
