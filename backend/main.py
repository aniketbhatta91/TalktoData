"""Conversational data-analysis app with RAG. Run: uvicorn main:app --reload"""
import asyncio
import json as _json
import queue
import shutil
import tempfile
import threading
from pathlib import Path

import pandas as pd
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

import uuid

from services import agent, analysis, cache as response_cache, domain_knowledge, pii, rag, session_store, suggestions as _suggestions
from services import settings as app_settings

_pending_uploads: dict[str, dict] = {}  # pending_id -> {df, name, session_id, findings}

app = FastAPI(title="Conversational Data Analyst")


@app.on_event("startup")
async def seed_domain_knowledge():
    rag.seed_glossaries(domain_knowledge.GLOSSARIES)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _save_temp(upload: UploadFile) -> Path:
    suffix = Path(upload.filename or "file").suffix
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        shutil.copyfileobj(upload.file, tmp)
        return Path(tmp.name)


@app.post("/api/upload/data")
async def upload_data(
    file: UploadFile = File(...),
    session_id: str = Form(None),
    domain: str = Form("general"),
):
    """Upload CSV/Excel into a session (new or existing). Profiles the data and
    embeds summaries into the vector DB."""
    if not file.filename or not file.filename.lower().endswith((".csv", ".xlsx", ".xls")):
        raise HTTPException(400, "Please upload a .csv, .xlsx or .xls file")
    path = _save_temp(file)
    try:
        df = analysis.load_dataframe(str(path), file.filename)
    except Exception as e:
        raise HTTPException(400, f"Could not parse file: {e}") from e
    finally:
        path.unlink(missing_ok=True)

    findings = pii.scan(df)
    if findings:
        pending_id = uuid.uuid4().hex[:12]
        _pending_uploads[pending_id] = {
            "df": df, "name": Path(file.filename).stem,
            "session_id": session_id, "domain": domain,
        }
        return {
            "pii_detected": True,
            "pending_id": pending_id,
            "findings": findings,
        }
    response_cache.clear()  # new data = stale cached answers
    return _finalize_dataset(df, Path(file.filename).stem, session_id, domain)


def _finalize_dataset(df, name: str, session_id: str | None, domain: str = "general") -> dict:
    profile = analysis.auto_profile(df)
    sid, session = session_store.get_or_create(session_id)
    name = session_store.add_dataset(session, name, df, profile)
    summaries = rag.ingest_data_summaries(df, name, domain)
    # Generate dataset-aware prompt suggestions via the fast LLM
    suggs = _suggestions.generate(profile, domain, name)
    return {
        "session_id": sid,
        "dataset": name,
        "datasets": session_store.dataset_summary(session),
        "data_summaries_indexed": summaries,
        "suggestions": suggs,
    }


class PiiDecision(BaseModel):
    pending_id: str
    action: str  # "mask" or "proceed"


@app.post("/api/upload/confirm")
async def confirm_upload(req: PiiDecision):
    """Resolve a PII-flagged upload: mask the PII or proceed with raw data."""
    pending = _pending_uploads.pop(req.pending_id, None)
    if pending is None:
        raise HTTPException(404, "Pending upload not found (it may have expired)")
    df = pending["df"]
    if req.action == "mask":
        df = pii.mask(df, pii.scan(df))
    elif req.action != "proceed":
        raise HTTPException(400, "action must be 'mask' or 'proceed'")
    return {
        **_finalize_dataset(df, pending["name"], pending["session_id"], pending.get("domain", "general")),
        "pii_action": req.action,
    }


class JoinRequest(BaseModel):
    session_id: str
    left: str
    right: str
    how: str = "inner"  # inner | left | right | outer
    on: list[str] = []


@app.post("/api/join")
async def join_datasets(req: JoinRequest):
    """Join two datasets in the session; result becomes a new (active) dataset."""
    session = session_store.get_session(req.session_id)
    if session is None:
        raise HTTPException(404, "Session not found")
    if req.how not in ("inner", "left", "right", "outer"):
        raise HTTPException(400, "Join type must be inner, left, right or outer")
    ldf, rdf = session.datasets.get(req.left), session.datasets.get(req.right)
    if ldf is None or rdf is None:
        raise HTTPException(404, "Dataset not found in session")

    keys = req.on or [c for c in ldf.columns if c in rdf.columns]
    missing = [k for k in keys if k not in ldf.columns or k not in rdf.columns]
    if not keys or missing:
        raise HTTPException(400, f"Join keys must exist in both datasets (missing: {missing or 'none in common'})")

    try:
        merged = pd.merge(ldf, rdf, how=req.how, on=keys, suffixes=("_" + req.left[:10], "_" + req.right[:10]))
    except Exception as e:
        raise HTTPException(400, f"Join failed: {e}") from e

    profile = analysis.auto_profile(merged)
    name = session_store.add_dataset(session, f"{req.left}_{req.how}_join_{req.right}", merged, profile)
    rag.ingest_data_summaries(merged, name)
    return {
        "dataset": name,
        "rows": int(merged.shape[0]),
        "join_keys": keys,
        "datasets": session_store.dataset_summary(session),
    }


@app.post("/api/upload/docs")
async def upload_docs(files: list[UploadFile] = File(...), domain: str = Form("general")):
    """Upload context documents into the RAG knowledge base, tagged by domain."""
    results = []
    for f in files:
        path = _save_temp(f)
        try:
            chunks = rag.ingest_document(str(path), f.filename or "document", domain)
            results.append({"filename": f.filename, "chunks_indexed": chunks})
        except Exception as e:
            results.append({"filename": f.filename, "error": str(e)})
        finally:
            path.unlink(missing_ok=True)
    return {"ingested": results, **rag.knowledge_stats()}


class ChatRequest(BaseModel):
    session_id: str
    message: str
    history: list[dict] = []
    domain: str = ""


@app.post("/api/chat")
async def chat(req: ChatRequest):
    """Chat endpoint (non-streaming fallback)."""
    try:
        return agent.run_agent(req.session_id, req.message, req.history, req.domain)
    except Exception as e:
        raise HTTPException(500, str(e)) from e


@app.post("/api/chat/stream")
async def chat_stream(req: ChatRequest):
    """Streaming chat via Server-Sent Events.
    Events: intent | status | token | figures | done | error
    """
    q: queue.Queue = queue.Queue()

    def worker():
        try:
            for event in agent.run_agent_stream(
                req.session_id, req.message, req.history, req.domain
            ):
                q.put(("event", event))
        except Exception as exc:
            q.put(("error", str(exc)))
        finally:
            q.put(("done", None))

    threading.Thread(target=worker, daemon=True).start()

    async def generate():
        loop = asyncio.get_event_loop()
        while True:
            kind, payload = await loop.run_in_executor(None, q.get)
            if kind == "event":
                yield f"data: {_json.dumps(payload)}\n\n"
            elif kind == "error":
                yield f"data: {_json.dumps({'type': 'error', 'text': payload})}\n\n"
                yield f"data: {_json.dumps({'type': 'done'})}\n\n"
                return
            elif kind == "done":
                yield f"data: {_json.dumps({'type': 'done'})}\n\n"
                return

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/api/health")
async def health():
    return {"status": "ok", **rag.knowledge_stats()}


class SettingsUpdate(BaseModel):
    settings: dict = {}
    reset: bool = False


@app.get("/api/settings")
async def get_settings():
    return {
        "settings": app_settings.get_all(),
        "limits": app_settings.LIMITS,
        "defaults": app_settings.DEFAULTS,
    }


@app.post("/api/settings")
async def update_settings(req: SettingsUpdate):
    updated = app_settings.reset() if req.reset else app_settings.update(req.settings)
    return {"settings": updated}


# Serve the built frontend (frontend/dist) if present - lets one URL/tunnel serve everything
_dist = Path(__file__).resolve().parent.parent / "frontend" / "dist"
if _dist.is_dir():
    from fastapi.staticfiles import StaticFiles
    app.mount("/", StaticFiles(directory=str(_dist), html=True), name="frontend")
