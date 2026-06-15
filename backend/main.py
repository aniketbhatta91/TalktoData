"""Conversational data-analysis app with RAG + JWT auth. Run: uvicorn main:app --reload"""
import asyncio
import json as _json
import queue
import shutil
import tempfile
import threading
import uuid
from pathlib import Path

import pandas as pd
from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel
from sqlalchemy.orm import Session

import config
from services import agent, analysis, cache as response_cache, domain_knowledge, pii, rag, session_store, suggestions as _suggestions
from services import settings as app_settings
from services.auth_utils import create_token, hash_password, verify_password
from services.database import User, create_tables, get_db, seed_admin

# ── Security scheme (optional Bearer — missing token gives 401) ───────────────
_bearer = HTTPBearer(auto_error=False)

_pending_uploads: dict[str, dict] = {}

app = FastAPI(title="Talk to Data")

# ── CORS (dev only; on Render the frontend is served by FastAPI itself) ───────
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Startup: create DB tables + seed admin ────────────────────────────────────
@app.on_event("startup")
async def startup():
    create_tables()
    if config.ADMIN_EMAIL and config.ADMIN_PASSWORD:
        hashed = hash_password(config.ADMIN_PASSWORD)
        seed_admin(config.ADMIN_EMAIL, config.ADMIN_NAME, hashed)
    await seed_domain_knowledge()


async def seed_domain_knowledge():
    rag.seed_glossaries(domain_knowledge.GLOSSARIES)


# ── Auth dependencies ─────────────────────────────────────────────────────────

def _get_token_payload(creds: HTTPAuthorizationCredentials | None) -> dict:
    from services.auth_utils import decode_token
    if not creds:
        raise HTTPException(401, "Not authenticated")
    payload = decode_token(creds.credentials)
    if not payload:
        raise HTTPException(401, "Invalid or expired token")
    return payload


def get_current_user(
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
    db: Session = Depends(get_db),
) -> User:
    payload = _get_token_payload(creds)
    user = db.query(User).filter(User.id == int(payload["sub"])).first()
    if not user:
        raise HTTPException(401, "User not found")
    if user.status != "approved":
        raise HTTPException(403, "Account not yet approved")
    return user


def require_admin(current_user: User = Depends(get_current_user)) -> User:
    if current_user.role != "admin":
        raise HTTPException(403, "Admin access required")
    return current_user


# ═══════════════════════════════════════════════════════════════════════════════
# AUTH ENDPOINTS
# ═══════════════════════════════════════════════════════════════════════════════

class SignUpRequest(BaseModel):
    name: str
    email: str
    password: str


class SignInRequest(BaseModel):
    email: str
    password: str


def _user_dict(u: User) -> dict:
    return {
        "id": u.id,
        "name": u.name,
        "email": u.email,
        "role": u.role,
        "status": u.status,
        "created_at": u.created_at.isoformat() if u.created_at else None,
        "approved_at": u.approved_at.isoformat() if u.approved_at else None,
    }


@app.post("/api/auth/signup")
async def signup(req: SignUpRequest, db: Session = Depends(get_db)):
    if not req.name.strip() or not req.email.strip() or not req.password:
        raise HTTPException(400, "Name, email, and password are required")
    if len(req.password) < 6:
        raise HTTPException(400, "Password must be at least 6 characters")
    existing = db.query(User).filter(User.email == req.email.lower().strip()).first()
    if existing:
        raise HTTPException(409, "An account with this email already exists")
    user = User(
        name=req.name.strip(),
        email=req.email.lower().strip(),
        password_hash=hash_password(req.password),
        role="user",
        status="pending",
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return {"message": "Account created. Awaiting admin approval.", "user": _user_dict(user)}


@app.post("/api/auth/signin")
async def signin(req: SignInRequest, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.email == req.email.lower().strip()).first()
    if not user or not verify_password(req.password, user.password_hash):
        raise HTTPException(401, "Invalid email or password")
    if user.status == "pending":
        raise HTTPException(403, "Your account is awaiting admin approval")
    if user.status == "rejected":
        raise HTTPException(403, "Your account access has been rejected")
    token = create_token(user.id, user.email, user.role)
    return {"token": token, "user": _user_dict(user)}


@app.get("/api/auth/me")
async def get_me(current_user: User = Depends(get_current_user)):
    return _user_dict(current_user)


# ═══════════════════════════════════════════════════════════════════════════════
# ADMIN ENDPOINTS
# ═══════════════════════════════════════════════════════════════════════════════

class StatusUpdate(BaseModel):
    status: str   # "approved" | "rejected" | "pending"


@app.get("/api/admin/users")
async def list_users(
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    users = db.query(User).order_by(User.created_at.desc()).all()
    return {"users": [_user_dict(u) for u in users]}


@app.patch("/api/admin/users/{user_id}/status")
async def update_user_status(
    user_id: int,
    req: StatusUpdate,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    if req.status not in ("approved", "rejected", "pending"):
        raise HTTPException(400, "status must be approved, rejected, or pending")
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(404, "User not found")
    if user.id == admin.id:
        raise HTTPException(400, "Cannot change your own status")
    from datetime import datetime
    user.status = req.status
    user.approved_at = datetime.utcnow() if req.status == "approved" else None
    db.commit()
    db.refresh(user)
    return {"user": _user_dict(user)}


# ═══════════════════════════════════════════════════════════════════════════════
# DATA ENDPOINTS  (all require valid JWT)
# ═══════════════════════════════════════════════════════════════════════════════

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
    current_user: User = Depends(get_current_user),
):
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
        return {"pii_detected": True, "pending_id": pending_id, "findings": findings}
    response_cache.clear()
    return _finalize_dataset(df, Path(file.filename).stem, session_id, domain)


def _finalize_dataset(df, name: str, session_id: str | None, domain: str = "general") -> dict:
    profile = analysis.auto_profile(df)
    sid, session = session_store.get_or_create(session_id)
    name = session_store.add_dataset(session, name, df, profile)
    summaries = rag.ingest_data_summaries(df, name, domain)
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
    action: str


@app.post("/api/upload/confirm")
async def confirm_upload(req: PiiDecision, current_user: User = Depends(get_current_user)):
    pending = _pending_uploads.pop(req.pending_id, None)
    if pending is None:
        raise HTTPException(404, "Pending upload not found")
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
    how: str = "inner"
    on: list[str] = []


@app.post("/api/join")
async def join_datasets(req: JoinRequest, current_user: User = Depends(get_current_user)):
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
async def upload_docs(
    files: list[UploadFile] = File(...),
    domain: str = Form("general"),
    current_user: User = Depends(get_current_user),
):
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
async def chat(req: ChatRequest, current_user: User = Depends(get_current_user)):
    try:
        return agent.run_agent(req.session_id, req.message, req.history, req.domain)
    except Exception as e:
        raise HTTPException(500, str(e)) from e


@app.post("/api/chat/stream")
async def chat_stream(req: ChatRequest, current_user: User = Depends(get_current_user)):
    q: queue.Queue = queue.Queue()

    def worker():
        try:
            for event in agent.run_agent_stream(req.session_id, req.message, req.history, req.domain):
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


class FeedbackRequest(BaseModel):
    session_id: str
    message_index: int
    feedback: str
    user_message: str = ""
    assistant_message: str = ""


@app.post("/api/feedback")
async def submit_feedback(req: FeedbackRequest, current_user: User = Depends(get_current_user)):
    import datetime
    record = {
        "timestamp": datetime.datetime.utcnow().isoformat() + "Z",
        "user_id": current_user.id,
        "user_email": current_user.email,
        "session_id": req.session_id,
        "message_index": req.message_index,
        "feedback": req.feedback,
        "user_message": req.user_message[:1000],
        "assistant_message": req.assistant_message[:2000],
    }
    print(f"[FEEDBACK] {_json.dumps(record)}", flush=True)
    try:
        with open("feedback.jsonl", "a") as f:
            f.write(_json.dumps(record) + "\n")
    except Exception:
        pass
    return {"status": "recorded", "feedback": req.feedback}


@app.get("/api/health")
async def health():
    return {"status": "ok", **rag.knowledge_stats()}


class SettingsUpdate(BaseModel):
    settings: dict = {}
    reset: bool = False


@app.get("/api/settings")
async def get_settings(current_user: User = Depends(get_current_user)):
    return {
        "settings": app_settings.get_all(),
        "limits": app_settings.LIMITS,
        "defaults": app_settings.DEFAULTS,
    }


@app.post("/api/settings")
async def update_settings(req: SettingsUpdate, current_user: User = Depends(get_current_user)):
    updated = app_settings.reset() if req.reset else app_settings.update(req.settings)
    return {"settings": updated}


# ── Serve built frontend (frontend/dist) ──────────────────────────────────────
_dist = Path(__file__).resolve().parent.parent / "frontend" / "dist"
if _dist.is_dir():
    from fastapi.staticfiles import StaticFiles
    app.mount("/", StaticFiles(directory=str(_dist), html=True), name="frontend")
