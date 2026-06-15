import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { sendChatStream } from './api'
import DomainSelect from './components/DomainSelect'
import HelpPanel from './components/HelpPanel'
import FileUpload from './components/FileUpload'
import HeroGraphic from './components/HeroGraphic'
import Hologram from './components/Hologram'
import JoinPanel from './components/JoinPanel'
import Welcome from './components/Welcome'
import PlotlyChart from './components/PlotlyChart'
import {
  loadSessions, upsertSession, removeSession, genLocalId,
} from './components/SessionsPanel'

// Shown before any dataset is uploaded
const DEFAULT_SUGGESTIONS = ['Upload a dataset to see suggestions tailored to your data']

function fmtDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const diffMin = Math.floor((Date.now() - d) / 60000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const diffH = Math.floor(diffMin / 60)
  if (diffH < 24) return `${diffH}h ago`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export default function App() {
  const [userName, setUserName] = useState('')
  const [domain, setDomain] = useState(null)
  const [session, setSession] = useState(null)           // backend session (dataset)
  const [suggestions, setSuggestions] = useState(DEFAULT_SUGGESTIONS)
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [status, setStatus] = useState('Upload a CSV/Excel file to begin.')
  const [loading, setLoading] = useState(false)
  const [focused, setFocused] = useState(false)

  // Persistent session history stored in localStorage
  const [sessions, setSessions] = useState(() => loadSessions())
  const currentLocalId = useRef(genLocalId())   // local ID for current chat

  const bottomRef = useRef(null)

  /* ── auto-scroll ──────────────────────────────────────────────────────── */
  useEffect(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), [messages, loading])

  /* ── background switch once chat starts ──────────────────────────────── */
  useEffect(() => {
    document.body.classList.toggle('chat-active', messages.length > 0)
  }, [messages.length])

  /* ── persist current session whenever messages change ────────────────── */
  useEffect(() => {
    if (!messages.length || !domain) return
    const userMsgs = messages.filter(m => m.role === 'user')
    if (!userMsgs.length) return

    const patch = {
      localId: currentLocalId.current,
      id: session?.session_id || null,
      name: session?.dataset || domain.label,
      domain,
      suggestions,
      // dataset names so the user knows what to re-upload on restore
      datasets: session?.datasets?.map(d => d.name || d) || (session?.dataset ? [session.dataset] : []),
      // store only role+text (no figures — too large for localStorage)
      messages: messages.map(m => ({ role: m.role, text: m.text, intent: m.intent })),
      messageCount: userMsgs.length,
      createdAt: sessions.find(s => s.localId === currentLocalId.current)?.createdAt || new Date().toISOString(),
      lastAt: new Date().toISOString(),
    }
    setSessions(prev => upsertSession(prev, patch))
  }, [messages]) // eslint-disable-line react-hooks/exhaustive-deps

  /* ── suggestion filtering ────────────────────────────────────────────── */
  const matches = input.trim()
    ? suggestions.filter(s => s.toLowerCase().includes(input.trim().toLowerCase()))
    : suggestions
  const showSuggestionBox = focused && session && matches.length > 0

  /* ── dataset uploaded ────────────────────────────────────────────────── */
  const handleDataUploaded = (res) => {
    setSession(res)
    if (Array.isArray(res.suggestions) && res.suggestions.length > 0) {
      setSuggestions(res.suggestions)
    }
  }

  /* ── send message (streaming) ────────────────────────────────────────── */
  const send = async () => {
    const text = input.trim()
    if (!text || loading) return
    if (!session) { setStatus('Upload a data file first.'); return }
    setInput('')
    setLoading(true)

    const history = messages.map(m => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: m.text,
    }))

    setMessages(m => [
      ...m,
      { role: 'user', text },
      { role: 'assistant', text: '', figures: [], intent: null, streaming: true },
    ])

    const patch = (fn) =>
      setMessages(m => {
        const msgs = [...m]
        const i = msgs.length - 1
        if (msgs[i]?.role === 'assistant') msgs[i] = fn(msgs[i])
        return msgs
      })

    try {
      await sendChatStream(session.session_id, text, history, domain?.id, (event) => {
        if (event.type === 'token') {
          patch(msg => ({ ...msg, text: msg.text + event.text }))
        } else if (event.type === 'figures') {
          patch(msg => ({ ...msg, figures: event.figures }))
        } else if (event.type === 'intent') {
          patch(msg => ({ ...msg, intent: event.intent }))
        } else if (event.type === 'done') {
          patch(msg => ({ ...msg, streaming: false }))
          setLoading(false)
        } else if (event.type === 'error') {
          patch(msg => ({ ...msg, text: `Error: ${event.text}`, streaming: false }))
          setLoading(false)
        }
      })
    } catch (err) {
      patch(msg => ({ ...msg, text: `Error: ${err.message}`, streaming: false }))
      setLoading(false)
    }
  }

  /* ── session management ──────────────────────────────────────────────── */
  const startNewSession = () => {
    currentLocalId.current = genLocalId()
    setSession(null)
    setMessages([])
    setInput('')
    setSuggestions(DEFAULT_SUGGESTIONS)
    setStatus('Upload a CSV/Excel file to begin.')
  }

  const switchSession = (saved) => {
    currentLocalId.current = saved.localId
    setDomain(saved.domain)
    setMessages(saved.messages || [])
    setSuggestions(saved.suggestions || DEFAULT_SUGGESTIONS)
    setSession(null)   // dataset must be re-uploaded; backend session is gone
    const fileList = saved.datasets?.length ? saved.datasets.join(', ') : 'your dataset'
    setStatus(`Chat restored. Re-upload ${fileList} to continue analysis.`)
    setInput('')
  }

  const deleteSession = (localId) => {
    setSessions(prev => removeSession(prev, localId))
    // If deleting the current session, start fresh
    if (localId === currentLocalId.current) startNewSession()
  }

  /* ── routing ─────────────────────────────────────────────────────────── */
  if (!userName) return <Welcome onSubmit={setUserName} />
  if (!domain) return <DomainSelect onSelect={setDomain} />

  const resetDomain = () => {
    setDomain(null)
    setSession(null)
    setMessages([])
    setInput('')
    setStatus('Upload a data file to begin.')
  }

  /* ── render ──────────────────────────────────────────────────────────── */
  return (
    <div className="app">
      <HelpPanel />

      <aside className="sidebar">
        <div className="brand">
          <HeroGraphic size={64} />
          <h1>Talk to Data</h1>
          <button className="domain-badge" onClick={resetDomain} title="Change domain">
            {domain.icon} {domain.label} ✕
          </button>
        </div>

        <FileUpload
          domain={domain}
          session={session}
          onDataUploaded={handleDataUploaded}
          onStatus={setStatus}
        />

        <JoinPanel
          session={session}
          onJoined={(res) => setSession(s => ({ ...s, datasets: res.datasets }))}
          onStatus={setStatus}
        />

        <p className="status">{status}</p>

        {/* ── Inline session history ── */}
        <div className="history-panel">
          <div className="history-header">
            <span>🕐 History</span>
            <button className="history-new" onClick={startNewSession} title="Start new session">＋ New</button>
          </div>

          {sessions.length === 0 ? (
            <p className="history-empty">No sessions yet. Upload data and start chatting.</p>
          ) : (
            <div className="history-list">
              {sessions.map(s => (
                <div
                  key={s.localId}
                  className={`history-item ${s.localId === currentLocalId.current ? 'history-item--active' : ''}`}
                >
                  <button className="history-restore" onClick={() => switchSession(s)}>
                    <span className="history-icon">{s.domain?.icon || '📊'}</span>
                    <div className="history-meta">
                      <span className="history-name">{s.name || 'Untitled'}</span>
                      {s.datasets?.length > 0 && (
                        <span className="history-files">📎 {s.datasets.join(', ')}</span>
                      )}
                      <span className="history-info">
                        {s.messageCount || 0} msgs · {fmtDate(s.lastAt)}
                      </span>
                    </div>
                  </button>
                  <button
                    className="history-delete"
                    title="Delete"
                    onClick={() => deleteSession(s.localId)}
                  >✕</button>
                </div>
              ))}
            </div>
          )}
        </div>
      </aside>

      <div className="main">
        <div className="topbar">
          <span className="welcome-text">Welcome, {userName}</span>
          <button className="switch-user" title="Change name" onClick={() => setUserName('')}>✎</button>
        </div>

        <main className="chat">
          {messages.length === 0 && (
            <div className="chat-empty">
              <p>Upload a dataset and ask anything about your data.</p>
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`msg ${m.role}`}>
              {m.intent && m.intent !== 'chitchat' && (
                <span className={`intent-chip ${m.intent}`}>
                  {{ data_analysis: 'Data analysis', knowledge_lookup: 'Knowledge base (RAG)', hybrid: 'Data + RAG' }[m.intent]}
                </span>
              )}
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.text}</ReactMarkdown>
              {m.streaming && m.text && <span className="cursor-blink">▋</span>}
              {m.figures?.map((fig, j) => <PlotlyChart key={j} figure={fig} />)}
            </div>
          ))}
          {loading && !messages[messages.length - 1]?.text && <Hologram />}
          <div ref={bottomRef} />
        </main>

        <footer>
          {showSuggestionBox && (
            <div className="suggestions">
              <span className="suggestions-title">Try asking</span>
              {matches.map(s => (
                <button
                  key={s}
                  className="suggestion"
                  onMouseDown={e => { e.preventDefault(); setInput(s) }}
                >
                  {s}
                </button>
              ))}
            </div>
          )}
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={e => e.key === 'Enter' && send()}
            placeholder="Ask about your data — analysis, charts, or why something happened…"
          />
          <button onClick={send} disabled={loading}>Send</button>
        </footer>
      </div>
    </div>
  )
}
