import { useEffect, useState } from 'react'
import { getSettings, saveSettings } from '../api'

const PARAM_INFO = {
  temperature: { label: 'Temperature', step: 0.1, desc: 'LLM creativity. Lower = precise/deterministic, higher = creative.' },
  max_tokens: { label: 'Max tokens', step: 256, desc: 'Maximum length of each model response.' },
  max_agent_turns: { label: 'Max agent turns', step: 1, desc: 'Tool-use loops allowed per question. Lower = faster, may cut off complex analyses.' },
  rag_top_k: { label: 'RAG top-K', step: 1, desc: 'Chunks retrieved from the vector DB per query. Higher = more context, slower.' },
  chunk_size: { label: 'Chunk size', step: 100, desc: 'Characters per chunk. Applies to documents uploaded AFTER changing.' },
  chunk_overlap: { label: 'Chunk overlap', step: 25, desc: 'Characters shared between neighboring chunks.' },
}

function HelpContent() {
  return (
    <div className="help-content">
      <h3>Architecture</h3>
      <p>Talk to Data is a conversational data-analysis app with agentic RAG.</p>

      <h4>Stack</h4>
      <ul>
        <li><strong>Frontend:</strong> React 18 + Vite, Plotly.js charts</li>
        <li><strong>Backend:</strong> FastAPI (Python)</li>
        <li><strong>Vector DB:</strong> ChromaDB (local, persistent, HNSW index, cosine similarity)</li>
        <li><strong>Embeddings:</strong> all-MiniLM-L6-v2 sentence-transformer (384-dim, runs locally via ONNX)</li>
        <li><strong>RAG framework:</strong> custom-built (no LangChain/LlamaIndex) — direct ChromaDB + LLM tool-calling</li>
        <li><strong>LLM providers:</strong> Anthropic Claude or any OpenAI-compatible API (Groq, Ollama)</li>
      </ul>

      <h4>Multi-agent flow</h4>
      <ul>
        <li><strong>Router agent</strong> (small fast model): classifies each prompt as data analysis, knowledge lookup (RAG), or hybrid — runs in parallel with vector retrieval</li>
        <li><strong>Analyst agent</strong> (large model) with three tools: <code>run_python</code> (pandas/Plotly, AST security guard), <code>run_sql</code> (DuckDB, SELECT-only), <code>search_knowledge_base</code> (ChromaDB)</li>
      </ul>

      <h4>RAG pipeline</h4>
      <ul>
        <li><strong>Chunking:</strong> fixed-size (~900 chars, 150 overlap), sentence-boundary aware</li>
        <li><strong>Sources:</strong> uploaded docs (PDF/Word/Excel/CSV/text) + auto-generated per-period data summaries</li>
        <li><strong>Retrieval:</strong> dense semantic search, top-K chunks, document chunks ranked above data summaries</li>
      </ul>

      <h4>Guardrails</h4>
      <ul>
        <li>PII detection (email/phone/cards/SSN/Aadhaar/PAN) with mask-or-proceed choice</li>
        <li>Python AST guard: no imports, file, network, or system access</li>
        <li>SQL pruning: single SELECT only, DDL/DML blocked, external access disabled</li>
      </ul>
    </div>
  )
}

function TuneContent() {
  const [data, setData] = useState(null)
  const [saved, setSaved] = useState('')

  useEffect(() => {
    getSettings().then(setData).catch(() => setSaved('Could not load settings - is the backend running?'))
  }, [])

  if (!data) return <p className="help-dim">{saved || 'Loading…'}</p>

  const set = (key, value) =>
    setData((d) => ({ ...d, settings: { ...d.settings, [key]: value } }))

  const save = async (reset = false) => {
    try {
      const res = await saveSettings(reset ? {} : data.settings, reset)
      setData((d) => ({ ...d, settings: res.settings }))
      setSaved(reset ? 'Reset to defaults.' : 'Saved - applies to the next question.')
    } catch (e) {
      setSaved(`Error: ${e.message}`)
    }
  }

  return (
    <div className="help-content">
      <h3>Tune parameters</h3>
      {Object.entries(PARAM_INFO).map(([key, info]) => {
        const [lo, hi] = data.limits[key]
        return (
          <div key={key} className="tune-row">
            <label>
              {info.label}: <strong>{data.settings[key]}</strong>
              <span className="tune-range"> ({lo}–{hi})</span>
            </label>
            <input
              type="range" min={lo} max={hi} step={info.step}
              value={data.settings[key]}
              onChange={(e) => set(key, parseFloat(e.target.value))}
            />
            <p className="tune-desc">{info.desc}</p>
          </div>
        )
      })}
      <div className="tune-actions">
        <button className="primary" onClick={() => save(false)}>Save</button>
        <button onClick={() => save(true)}>Reset defaults</button>
      </div>
      {saved && <p className="tune-saved">{saved}</p>}
    </div>
  )
}

export default function HelpPanel() {
  const [open, setOpen] = useState(null) // null | 'help' | 'tune'

  return (
    <>
      <div className="fab-stack">
        <button className="fab" title="About this app" onClick={() => setOpen(open === 'help' ? null : 'help')}>?</button>
        <button className="fab" title="Tune parameters" onClick={() => setOpen(open === 'tune' ? null : 'tune')}>⚙</button>
      </div>
      {open && (
        <div className="drawer">
          <div className="drawer-head">
            <span>{open === 'help' ? 'About Talk to Data' : 'Performance tuning'}</span>
            <button className="drawer-close" onClick={() => setOpen(null)}>✕</button>
          </div>
          {open === 'help' ? <HelpContent /> : <TuneContent />}
        </div>
      )}
    </>
  )
}
