"""Runtime-tunable application settings (adjusted from the UI Tune panel)."""

DEFAULTS = {
    "temperature": 0.2,       # LLM creativity (lower = more deterministic)
    "max_tokens": 4096,       # max LLM response length
    "max_agent_turns": 8,     # max tool-use loops per question
    "rag_top_k": 6,           # chunks retrieved per RAG query
    "chunk_size": 900,        # characters per chunk (applies to NEW uploads)
    "chunk_overlap": 150,     # overlap between chunks (applies to NEW uploads)
}

LIMITS = {
    "temperature": (0.0, 1.0),
    "max_tokens": (256, 8192),
    "max_agent_turns": (2, 16),
    "rag_top_k": (1, 20),
    "chunk_size": (200, 4000),
    "chunk_overlap": (0, 500),
}

_settings = dict(DEFAULTS)


def get_all() -> dict:
    return dict(_settings)


def update(new: dict) -> dict:
    for key, value in new.items():
        if key not in DEFAULTS:
            continue
        try:
            value = float(value)
        except (TypeError, ValueError):
            continue
        lo, hi = LIMITS[key]
        value = min(max(value, lo), hi)
        _settings[key] = value if key == "temperature" else int(value)
    return get_all()


def reset() -> dict:
    _settings.clear()
    _settings.update(DEFAULTS)
    return get_all()
