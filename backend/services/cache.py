"""Simple TTL in-memory response cache.

Key = sha256(session_id + message + domain + sorted dataset names).
Avoids re-running the full LLM + tool loop for identical repeated queries.
"""
import hashlib
import time

_store: dict[str, tuple[dict, float]] = {}
TTL = 300  # seconds (5 minutes)


def _key(session_id: str, message: str, domain: str, dataset_names: list[str]) -> str:
    raw = f"{session_id}:{message.strip().lower()}:{domain}:{','.join(sorted(dataset_names))}"
    return hashlib.sha256(raw.encode()).hexdigest()[:24]


def get(session_id: str, message: str, domain: str, dataset_names: list[str]) -> dict | None:
    """Return cached result or None if missing / expired."""
    k = _key(session_id, message, domain, dataset_names)
    entry = _store.get(k)
    if entry is None:
        return None
    result, ts = entry
    if time.time() - ts > TTL:
        del _store[k]
        return None
    return result


def put(session_id: str, message: str, domain: str, dataset_names: list[str], result: dict) -> None:
    """Store result; also evict stale entries."""
    now = time.time()
    stale = [k for k, (_, ts) in list(_store.items()) if now - ts > TTL]
    for k in stale:
        _store.pop(k, None)
    _store[_key(session_id, message, domain, dataset_names)] = (result, now)


def clear() -> None:
    """Flush the entire cache (e.g., after a new dataset upload)."""
    _store.clear()
