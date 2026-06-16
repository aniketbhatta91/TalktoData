"""LLM tool-calling agent + streaming variant. Supports two providers (set LLM_PROVIDER in .env):

- anthropic: Claude API
- openai:    any OpenAI-compatible API - Groq (free open-source models),
             Ollama (local), OpenRouter, etc.

Tools available to the model:
- run_python: pandas/plotly analysis on the uploaded dataframe
- search_knowledge_base: RAG retrieval over ChromaDB for "why" questions
"""
import json
import re
import time

import config
from services import analysis, rag, session_store, settings, sql_guard


# ── Rate-limit retry helper ───────────────────────────────────────────────────

class RateLimitError(Exception):
    """Raised when all retry attempts are exhausted due to rate limiting."""


def _is_rate_limit(exc: Exception) -> bool:
    name = type(exc).__name__
    msg  = str(exc).lower()
    return (
        "ratelimit" in name.lower()
        or "rate_limit" in name.lower()
        or "429" in msg
        or "rate limit" in msg
        or "too many requests" in msg
        or "quota" in msg
    )


def _retry(fn, *args, max_retries: int = 3, base_delay: float = 5.0, **kwargs):
    """Call fn(*args, **kwargs) with exponential backoff on rate-limit errors.

    Delays:  attempt 1 → base_delay s,  attempt 2 → base_delay*2 s,  etc.
    Raises RateLimitError after max_retries are exhausted.
    """
    last_exc = None
    for attempt in range(max_retries + 1):
        try:
            return fn(*args, **kwargs)
        except Exception as exc:
            if not _is_rate_limit(exc):
                raise               # non-rate-limit errors bubble immediately
            last_exc = exc
            if attempt < max_retries:
                wait = base_delay * (2 ** attempt)
                print(f"[WARN] Rate limit hit — retrying in {wait:.0f}s "
                      f"(attempt {attempt + 1}/{max_retries})", flush=True)
                time.sleep(wait)

    raise RateLimitError(
        f"Rate limit reached after {max_retries} retries. "
        "Please wait a moment and try again, or reduce the size of your request."
    ) from last_exc


def _strip_code_blocks(text: str) -> str:
    """Remove ```python ... ``` fenced code blocks from LLM response text.
    The model should never echo back the analysis code — only results."""
    # Remove ```python ... ``` and plain ``` ... ``` blocks
    cleaned = re.sub(r'```(?:python|py)?\n[\s\S]*?```', '', text, flags=re.IGNORECASE)
    # Collapse multiple blank lines left behind
    cleaned = re.sub(r'\n{3,}', '\n\n', cleaned)
    return cleaned.strip()

RUN_PYTHON_DESC = (
    "Execute Python against the uploaded data. In scope: `df` (the active "
    "dataset), `dfs` (dict of ALL uploaded datasets by name), plus pd, np, "
    "px (plotly.express), go (plotly.graph_objects). print() text results. "
    "Assign plotly figures to variables named fig, fig1, fig2... and they "
    "will be rendered to the user. Never use matplotlib, file I/O, or "
    "imports other than the provided modules."
)
SEARCH_DESC = (
    "Semantic search over the knowledge base (user-uploaded context documents "
    "and auto-generated dataset summaries). Use this for 'why' / causal / "
    "explanatory questions, e.g. 'why did revenue dip in Q3'."
)
RUN_PYTHON_SCHEMA = {
    "type": "object",
    "properties": {"code": {"type": "string", "description": "Python code to run"}},
    "required": ["code"],
}
SEARCH_SCHEMA = {
    "type": "object",
    "properties": {"query": {"type": "string", "description": "Search query"}},
    "required": ["query"],
}
RUN_SQL_DESC = (
    "Run a read-only SQL SELECT query over the uploaded datasets (each dataset "
    "is a table with its dataset name). Use for joins, aggregations, and "
    "filtering when SQL is more natural than pandas. Only single SELECT/WITH "
    "statements are allowed - DDL/DML is blocked."
)
RUN_SQL_SCHEMA = {
    "type": "object",
    "properties": {"query": {"type": "string", "description": "A single SELECT query"}},
    "required": ["query"],
}

SYSTEM_PROMPT = """You are a senior data analyst assistant.

The user has uploaded one or more datasets. The active dataset is `df`
(named '{active}'); all datasets are available as dfs['name'].
Dataset profiles:
{profile}

Rules:
- For analytical requests (stats, outliers, sanity checks, trends, charts, EDA), use run_python. Prefer plotly charts when a visual helps.
- For "why" / causal / explanatory questions, FIRST use search_knowledge_base to retrieve context, then optionally run_python to verify numbers, then answer grounded in the retrieved context. Cite sources by name. If retrieval returns nothing relevant, say so honestly instead of inventing causes.
- Quarters/periods: infer from the date column in the data.
- When the user asks for a table or detailed listing, output a proper markdown table (the UI renders them).
- Be concise. Report concrete numbers. After fixing a failed code attempt, don't narrate the failure.
- CRITICAL: NEVER output raw Python code blocks in your text response. ALL code execution must go through the run_python tool. Only show results, insights, and numbers — never the code itself.

FOLDER UPLOADS — FILENAME ANALYSIS:
When the user uploads a folder, a dataset named '_folder_manifest' is automatically created.
It has these columns:
  filename         — full file name, e.g. "John_Smith_AWS_Certification.pdf"
  name_without_ext — filename without extension, e.g. "John_Smith_AWS_Certification"
  filepath         — relative path including any subfolders
  size_kb          — file size in KB
  extension        — file extension (pdf, xlsx, csv, …)
  file_type        — "data", "document", or "other"

File names often encode structured information. Common patterns:
  "AssociateName_CertificationName.pdf"     → split on "_" or "-"
  "FirstName LastName - Course Title.pdf"   → split on " - "
  "EMPID_Name_CourseName_Date.xlsx"         → split on "_"

When asked to build a table, pivot, or report from the folder (e.g., "which associates
completed which certifications"), use run_python on '_folder_manifest':
  1. Load: manifest = dfs.get('_folder_manifest', df)
  2. Inspect manifest['name_without_ext'] to identify the separator and field positions
  3. Parse into structured columns (associate, certification, date, etc.)
  4. Print or return a clean markdown table

If the exact separator isn't clear, look at a few examples from manifest['filename'] first,
then split accordingly. Always show the parsed table, not the raw filenames.
"""


def _execute_tool(name: str, args: dict, session, figures: list, domain: str = "") -> str:
    if name == "run_python":
        result = analysis.run_code(args.get("code", ""), session.datasets, session.active)
        figures.extend(result.pop("figures"))
        return json.dumps(result)[:20000]
    if name == "run_sql":
        return json.dumps(sql_guard.run_sql(args.get("query", ""), session.datasets), default=str)[:20000]
    if name == "search_knowledge_base":
        hits = rag.search(args.get("query", ""), domain=domain or None)
        if hits:
            return json.dumps({"results": hits})[:20000]
        return json.dumps({"results": [], "note": "Knowledge base is empty or has no relevant context."})
    return json.dumps({"error": f"Unknown tool {name}"})


INTENT_LABELS = ("data_analysis", "knowledge_lookup", "hybrid", "chitchat")

INTENT_SYSTEM = """You are an intent classifier for a data-analysis assistant.
The user has uploaded tabular datasets AND possibly context documents (reports, notes, reviews, policies).
Classify the LATEST user message into exactly one label:
data_analysis - compute or visualize from the dataset: stats, charts, outliers, trends, sanity checks, joins, filters
knowledge_lookup - answerable from context documents: why/causes, background, decisions, policies, narrative explanations
hybrid - needs BOTH dataset numbers AND document explanations (e.g. "show the dip and explain why it happened")
chitchat - greetings, small talk, anything else
Reply with ONLY the label, nothing else."""


def _classify_intent(message: str, history: list) -> str:
    recent = " | ".join(str(h.get("content", ""))[:200] for h in history[-4:])
    prompt = f"Conversation so far: {recent}\nLatest message: {message}" if recent else message
    try:
        if config.LLM_PROVIDER == "openai":
            from openai import OpenAI
            client = OpenAI(base_url=config.OPENAI_BASE_URL, api_key=config.OPENAI_API_KEY or "none")
            r = client.chat.completions.create(
                model=config.OPENAI_FAST_MODEL, max_tokens=20,
                messages=[{"role": "system", "content": INTENT_SYSTEM},
                          {"role": "user", "content": prompt}],
            )
            label = (r.choices[0].message.content or "").strip().lower()
        else:
            import anthropic
            client = anthropic.Anthropic(api_key=config.ANTHROPIC_API_KEY)
            r = client.messages.create(
                model=config.ANTHROPIC_FAST_MODEL, max_tokens=10,
                system=INTENT_SYSTEM, messages=[{"role": "user", "content": prompt}],
            )
            label = "".join(b.text for b in r.content if b.type == "text").strip().lower()
    except Exception:
        return "hybrid"  # safe default: retrieve AND analyze
    for known in INTENT_LABELS:
        if known in label:
            return known
    return "hybrid"


DOMAIN_PERSONAS = {
    "healthcare": "You specialize in healthcare analytics: patient outcomes, length of stay, readmissions, clinical KPIs, bed occupancy, cost per case. Mind HIPAA-style data sensitivity.",
    "supplychain": "You specialize in supply chain analytics: inventory turnover, lead times, OTIF, stockouts, demand forecasting, supplier performance, logistics costs.",
    "hr": "You specialize in HR/people analytics: attrition, headcount, hiring funnels, compensation, engagement, diversity metrics. Treat employee data as highly confidential.",
    "retail": "You specialize in retail analytics: sales trends, basket analysis, customer segments, pricing, promotions, store/channel performance, seasonality.",
}


def run_agent(session_id: str, message: str, history: list, domain: str = "") -> dict:
    session = session_store.get_session(session_id)
    if session is None or not session.datasets:
        return {"text": "Session not found - please re-upload your data file.", "figures": []}

    per_ds_budget = max(6000 // max(len(session.profiles), 1), 1500)
    profiles = {
        name: json.dumps(p, default=str)[:per_ds_budget]
        for name, p in session.profiles.items()
    }
    system = SYSTEM_PROMPT.format(active=session.active, profile=json.dumps(profiles))
    if domain in DOMAIN_PERSONAS:
        system += "\n" + DOMAIN_PERSONAS[domain]

    # ---- router stage: intent classification (fast model) and RAG retrieval
    # run in PARALLEL so the router adds minimal latency ----
    from concurrent.futures import ThreadPoolExecutor

    cfg = settings.get_all()
    with ThreadPoolExecutor(max_workers=2) as pool:
        intent_future = pool.submit(_classify_intent, message, history)
        hits_future = pool.submit(rag.search, message, cfg["rag_top_k"], domain or None)
        intent = intent_future.result()
        hits = hits_future.result() if intent in ("knowledge_lookup", "hybrid") else []

    if intent in ("knowledge_lookup", "hybrid"):
        rank = {"document": 0, "glossary": 1, "data_summary": 2}
        ordered = sorted(hits, key=lambda h: rank.get(h.get("type"), 3))
        if ordered:
            ctx = "\n".join(f"- [{h['source']}] {h['text']}" for h in ordered)[:5000]
            system += (
                "\n\nThis question requires the knowledge base. Retrieved context "
                "(you MUST ground your explanation in it and cite sources by name):\n" + ctx
            )
            if intent == "hybrid":
                system += "\nAlso verify the relevant numbers with run_python or run_sql."
            else:
                system += "\nDo not answer from the dataset alone when this context is relevant."
        else:
            system += (
                "\n\nThe knowledge base has no relevant context for this question. "
                "Say so honestly instead of inventing causes; offer data-derived "
                "observations only, clearly labeled as such."
            )
    elif intent == "data_analysis":
        system += "\n\nThis is a data-analysis request: answer with run_python or run_sql on the datasets."

    try:
        if config.LLM_PROVIDER == "openai":
            result = _run_openai(session, system, message, history, domain)
        else:
            result = _run_anthropic(session, system, message, history, domain)
    except RateLimitError as e:
        return {"text": f"⚠️ {e}", "figures": [], "intent": intent}
    result["intent"] = intent
    return result


# ---------- Anthropic (Claude) non-streaming ----------

def _run_anthropic(session, system: str, message: str, history: list, domain: str = "") -> dict:
    import anthropic

    client = anthropic.Anthropic(api_key=config.ANTHROPIC_API_KEY)
    tools = [
        {"name": "run_python", "description": RUN_PYTHON_DESC, "input_schema": RUN_PYTHON_SCHEMA},
        {"name": "run_sql", "description": RUN_SQL_DESC, "input_schema": RUN_SQL_SCHEMA},
        {"name": "search_knowledge_base", "description": SEARCH_DESC, "input_schema": SEARCH_SCHEMA},
    ]
    messages = [*history, {"role": "user", "content": message}]
    figures = []
    cfg = settings.get_all()

    for _ in range(cfg["max_agent_turns"]):
        response = _retry(
            client.messages.create,
            model=config.ANTHROPIC_MODEL, max_tokens=cfg["max_tokens"],
            temperature=cfg["temperature"],
            system=system, tools=tools, messages=messages,
        )
        if response.stop_reason != "tool_use":
            text = "".join(b.text for b in response.content if b.type == "text")
            return {"text": _strip_code_blocks(text), "figures": figures}

        messages.append({"role": "assistant", "content": response.content})
        tool_results = [
            {
                "type": "tool_result",
                "tool_use_id": block.id,
                "content": _execute_tool(block.name, block.input, session, figures, domain),
            }
            for block in response.content
            if block.type == "tool_use"
        ]
        messages.append({"role": "user", "content": tool_results})

    return {"text": "I hit the maximum number of analysis steps. Try a more specific question.", "figures": figures}


# ---------- OpenAI-compatible (Groq / Ollama / OpenRouter) non-streaming ----------

def _run_openai(session, system: str, message: str, history: list, domain: str = "") -> dict:
    from openai import OpenAI

    client = OpenAI(base_url=config.OPENAI_BASE_URL, api_key=config.OPENAI_API_KEY or "none")
    tools = [
        {"type": "function", "function": {"name": "run_python", "description": RUN_PYTHON_DESC, "parameters": RUN_PYTHON_SCHEMA}},
        {"type": "function", "function": {"name": "run_sql", "description": RUN_SQL_DESC, "parameters": RUN_SQL_SCHEMA}},
        {"type": "function", "function": {"name": "search_knowledge_base", "description": SEARCH_DESC, "parameters": SEARCH_SCHEMA}},
    ]
    messages = [{"role": "system", "content": system}, *history, {"role": "user", "content": message}]
    figures = []
    cfg = settings.get_all()

    from openai import BadRequestError

    for _ in range(cfg["max_agent_turns"]):
        # Wrap in _retry for rate limits; keep inner loop for BadRequestError (tool_use_failed)
        def _create_completion():
            for attempt in range(3):
                try:
                    return client.chat.completions.create(
                        model=config.OPENAI_MODEL, messages=messages, tools=tools,
                        max_tokens=cfg["max_tokens"], temperature=cfg["temperature"],
                    )
                except BadRequestError as e:
                    if "tool_use_failed" not in str(e) or attempt == 2:
                        raise
            return None  # unreachable

        response = _retry(_create_completion)
        msg = response.choices[0].message
        if not msg.tool_calls:
            return {"text": _strip_code_blocks(msg.content or ""), "figures": figures}

        messages.append({
            "role": "assistant",
            "content": msg.content,
            "tool_calls": [
                {"id": tc.id, "type": "function",
                 "function": {"name": tc.function.name, "arguments": tc.function.arguments}}
                for tc in msg.tool_calls
            ],
        })
        for tc in msg.tool_calls:
            try:
                args = json.loads(tc.function.arguments or "{}")
            except json.JSONDecodeError:
                args = {}
            messages.append({
                "role": "tool",
                "tool_call_id": tc.id,
                "content": _execute_tool(tc.function.name, args, session, figures, domain),
            })

    return {"text": "I hit the maximum number of analysis steps. Try a more specific question.", "figures": figures}


# ═══════════════════════════════════════════════════════════════════════════════
# STREAMING VARIANTS
# ═══════════════════════════════════════════════════════════════════════════════

_TOOL_STATUS = {
    "run_python": "⚙️ Running analysis...",
    "run_sql": "🗄️ Running SQL query...",
    "search_knowledge_base": "🔍 Searching knowledge base...",
}


def _stream_openai(session, system: str, message: str, history: list, domain: str, cfg: dict):
    """Yield SSE-ready event dicts, streaming tokens from the OpenAI-compatible API."""
    from openai import OpenAI, BadRequestError

    client = OpenAI(base_url=config.OPENAI_BASE_URL, api_key=config.OPENAI_API_KEY or "none")
    tools = [
        {"type": "function", "function": {"name": "run_python", "description": RUN_PYTHON_DESC, "parameters": RUN_PYTHON_SCHEMA}},
        {"type": "function", "function": {"name": "run_sql", "description": RUN_SQL_DESC, "parameters": RUN_SQL_SCHEMA}},
        {"type": "function", "function": {"name": "search_knowledge_base", "description": SEARCH_DESC, "parameters": SEARCH_SCHEMA}},
    ]
    messages = [{"role": "system", "content": system}, *history, {"role": "user", "content": message}]
    figures = []

    for _ in range(cfg["max_agent_turns"]):
        def _create_stream():
            for attempt in range(3):
                try:
                    return client.chat.completions.create(
                        model=config.OPENAI_MODEL, messages=messages, tools=tools,
                        max_tokens=cfg["max_tokens"], temperature=cfg["temperature"],
                        stream=True,
                    )
                except BadRequestError as e:
                    if "tool_use_failed" not in str(e) or attempt == 2:
                        raise
            return None  # unreachable

        stream = _retry(_create_stream)

        full_content = ""
        content_buffer = []   # buffer tokens — flush only if no tool call follows
        tool_calls = {}

        for chunk in stream:
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta

            if delta.content:
                full_content += delta.content
                content_buffer.append(delta.content)  # buffer, don't yield yet

            if delta.tool_calls:
                for tc in delta.tool_calls:
                    idx = tc.index
                    if idx not in tool_calls:
                        tool_calls[idx] = {"id": "", "name": "", "arguments": ""}
                    if tc.id:
                        tool_calls[idx]["id"] = tc.id
                    if tc.function:
                        if tc.function.name:
                            tool_calls[idx]["name"] += tc.function.name
                        if tc.function.arguments:
                            tool_calls[idx]["arguments"] += tc.function.arguments

        if not tool_calls:
            # Final text response — flush buffer with code block stripping
            clean = _strip_code_blocks("".join(content_buffer))
            if clean:
                yield {"type": "token", "text": clean}
            yield {"type": "figures", "figures": list(figures)}
            return
        # Tool call present — discard content_buffer (it was model "thinking" code, not output)

        # Append assistant tool-call turn
        messages.append({
            "role": "assistant",
            "content": full_content or None,
            "tool_calls": [
                {"id": tc["id"], "type": "function",
                 "function": {"name": tc["name"], "arguments": tc["arguments"]}}
                for tc in tool_calls.values()
            ],
        })

        # Execute tools
        for tc in tool_calls.values():
            try:
                args = json.loads(tc["arguments"] or "{}")
            except json.JSONDecodeError:
                args = {}
            yield {"type": "status", "text": _TOOL_STATUS.get(tc["name"], f"Running {tc['name']}...")}
            result = _execute_tool(tc["name"], args, session, figures, domain)
            messages.append({"role": "tool", "tool_call_id": tc["id"], "content": result})

        yield {"type": "figures", "figures": list(figures)}

    yield {"type": "token", "text": "I reached the maximum analysis steps. Try a more specific question."}
    yield {"type": "figures", "figures": list(figures)}


def _stream_anthropic(session, system: str, message: str, history: list, domain: str, cfg: dict):
    """Yield SSE-ready event dicts, streaming tokens from the Anthropic API."""
    import anthropic

    client = anthropic.Anthropic(api_key=config.ANTHROPIC_API_KEY)
    tools = [
        {"name": "run_python", "description": RUN_PYTHON_DESC, "input_schema": RUN_PYTHON_SCHEMA},
        {"name": "run_sql", "description": RUN_SQL_DESC, "input_schema": RUN_SQL_SCHEMA},
        {"name": "search_knowledge_base", "description": SEARCH_DESC, "input_schema": SEARCH_SCHEMA},
    ]
    messages = [*history, {"role": "user", "content": message}]
    figures = []

    for _ in range(cfg["max_agent_turns"]):
        tool_uses = []
        current_tool = None
        text_buffer = []   # buffer text tokens; flush only after we know stop_reason

        def _open_stream():
            return client.messages.stream(
                model=config.ANTHROPIC_MODEL,
                max_tokens=cfg["max_tokens"],
                temperature=cfg["temperature"],
                system=system,
                tools=tools,
                messages=messages,
            )

        with _retry(_open_stream) as stream:
            for event in stream:
                etype = getattr(event, "type", None)

                if etype == "content_block_start":
                    block = event.content_block
                    if block.type == "tool_use":
                        current_tool = {"id": block.id, "name": block.name, "input": ""}

                elif etype == "content_block_delta":
                    delta = event.delta
                    dtype = getattr(delta, "type", None)
                    if dtype == "text_delta":
                        text_buffer.append(delta.text)   # buffer, don't yield yet
                    elif dtype == "input_json_delta" and current_tool is not None:
                        current_tool["input"] += delta.partial_json

                elif etype == "content_block_stop":
                    if current_tool is not None:
                        tool_uses.append(current_tool)
                        current_tool = None

            final_message = stream.get_final_message()

        if final_message.stop_reason != "tool_use" or not tool_uses:
            # Final answer — flush with code block stripping
            clean = _strip_code_blocks("".join(text_buffer))
            if clean:
                yield {"type": "token", "text": clean}
            yield {"type": "figures", "figures": list(figures)}
            return
        # Tool call — discard text_buffer (pre-tool thinking text)

        messages.append({"role": "assistant", "content": final_message.content})

        tool_results = []
        for tu in tool_uses:
            try:
                args = json.loads(tu["input"] or "{}")
            except Exception:
                args = {}
            yield {"type": "status", "text": _TOOL_STATUS.get(tu["name"], f"Running {tu['name']}...")}
            result = _execute_tool(tu["name"], args, session, figures, domain)
            tool_results.append({"type": "tool_result", "tool_use_id": tu["id"], "content": result})

        messages.append({"role": "user", "content": tool_results})
        yield {"type": "figures", "figures": list(figures)}

    yield {"type": "token", "text": "I reached the maximum analysis steps. Try a more specific question."}
    yield {"type": "figures", "figures": list(figures)}


def run_agent_stream(session_id: str, message: str, history: list, domain: str = ""):
    """Streaming entry point. Yields event dicts:
      {"type": "intent",   "intent": str}
      {"type": "status",   "text": str}      <- shown in hologram while tools run
      {"type": "token",    "text": str}       <- streamed response tokens
      {"type": "figures",  "figures": [...]}  <- plotly figures (cumulative)
    """
    from services import cache as _cache

    session = session_store.get_session(session_id)
    if session is None or not session.datasets:
        yield {"type": "token", "text": "Session not found - please re-upload your data file."}
        yield {"type": "figures", "figures": []}
        return

    dataset_names = list(session.datasets.keys())

    # ── Cache hit: replay instantly ────────────────────────────────────────────
    cached = _cache.get(session_id, message, domain, dataset_names)
    if cached:
        yield {"type": "intent", "intent": cached.get("intent", "data_analysis")}
        yield {"type": "token", "text": cached["text"]}
        yield {"type": "figures", "figures": cached.get("figures", [])}
        return

    # ── Build system prompt ────────────────────────────────────────────────────
    per_ds_budget = max(6000 // max(len(session.profiles), 1), 1500)
    profiles = {
        name: json.dumps(p, default=str)[:per_ds_budget]
        for name, p in session.profiles.items()
    }
    system = SYSTEM_PROMPT.format(active=session.active, profile=json.dumps(profiles))
    if domain in DOMAIN_PERSONAS:
        system += "\n" + DOMAIN_PERSONAS[domain]

    # ── Router: intent + RAG in parallel ──────────────────────────────────────
    from concurrent.futures import ThreadPoolExecutor

    cfg = settings.get_all()
    with ThreadPoolExecutor(max_workers=2) as pool:
        intent_future = pool.submit(_classify_intent, message, history)
        hits_future = pool.submit(rag.search, message, cfg["rag_top_k"], domain or None)
        intent = intent_future.result()
        hits = hits_future.result() if intent in ("knowledge_lookup", "hybrid") else []

    yield {"type": "intent", "intent": intent}

    if intent in ("knowledge_lookup", "hybrid"):
        rank = {"document": 0, "glossary": 1, "data_summary": 2}
        ordered = sorted(hits, key=lambda h: rank.get(h.get("type"), 3))
        if ordered:
            ctx = "\n".join(f"- [{h['source']}] {h['text']}" for h in ordered)[:5000]
            system += (
                "\n\nThis question requires the knowledge base. Retrieved context "
                "(you MUST ground your explanation in it and cite sources by name):\n" + ctx
            )
            if intent == "hybrid":
                system += "\nAlso verify the relevant numbers with run_python or run_sql."
            else:
                system += "\nDo not answer from the dataset alone when this context is relevant."
        else:
            system += (
                "\n\nThe knowledge base has no relevant context for this question. "
                "Say so honestly; offer data-derived observations only, clearly labeled as such."
            )
    elif intent == "data_analysis":
        system += "\n\nThis is a data-analysis request: answer with run_python or run_sql on the datasets."

    # ── Stream from LLM ───────────────────────────────────────────────────────
    if config.LLM_PROVIDER == "openai":
        gen = _stream_openai(session, system, message, history, domain, cfg)
    else:
        gen = _stream_anthropic(session, system, message, history, domain, cfg)

    text_buf = []
    final_figures = []

    try:
        for event in gen:
            yield event
            if event["type"] == "token":
                text_buf.append(event["text"])
            elif event["type"] == "figures":
                final_figures = event.get("figures", [])
    except RateLimitError as e:
        yield {"type": "token", "text": f"⚠️ {e}"}
        yield {"type": "figures", "figures": []}
        return

    # ── Cache the assembled result ────────────────────────────────────────────
    if text_buf:
        _cache.put(session_id, message, domain, dataset_names, {
            "text": "".join(text_buf),
            "figures": final_figures,
            "intent": intent,
        })
