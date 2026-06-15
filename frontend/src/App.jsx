import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { getMe, sendChatStream, sendFeedback } from './api'
import AdminPanel from './components/AdminPanel'
import AuthPage from './components/AuthPage'
import DomainSelect from './components/DomainSelect'
import FileUpload from './components/FileUpload'
import HelpPanel from './components/HelpPanel'
import HeroGraphic from './components/HeroGraphic'
import Hologram from './components/Hologram'
import JoinPanel from './components/JoinPanel'
import PlotlyChart from './components/PlotlyChart'
import { genLocalId, loadSessions, removeSession, upsertSession } from './components/SessionsPanel'

const DEFAULT_SUGGESTIONS = ['Upload a dataset to see suggestions tailored to your data']

// localStorage key scoped per user so histories don't mix between accounts
const sessionsKey = (userId) => `talk_to_data_sessions_${userId}`

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
  // ── Auth state ──────────────────────────────────────────────────────────────
  const [authUser, setAuthUser] = useState(null)      // null = not loaded yet
  const [authLoading, setAuthLoading] = useState(true)
  const [showAdmin, setShowAdmin] = useState(false)

  // ── App state ───────────────────────────────────────────────────────────────
  const [domain, setDomain] = useState(null)
  const [session, setSession] = useState(null)
  const [suggestions, setSuggestions] = useState(DEFAULT_SUGGESTIONS)
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [status, setStatus] = useState('Upload a CSV/Excel file to begin.')
  const [loading, setLoading] = useState(false)
  const [focused, setFocused] = useState(false)
  const [feedbacks, setFeedbacks] = useState({})
  const [sessions, setSessions] = useState([])

  const currentLocalId = useRef(genLocalId())
  const abortRef = useRef(null)
  const inputRef = useRef(null)
  const bottomRef = useRef(null)

  // ── On mount: validate stored token ────────────────────────────────────────
  useEffect(() => {
    const stored = localStorage.getItem('talk_to_data_user')
    if (stored) {
      try { setAuthUser(JSON.parse(stored)) } catch { /* ignore */ }
    }
    getMe().then(user => {
      if (user) {
        setAuthUser(user)
        localStorage.setItem('talk_to_data_user', JSON.stringify(user))
        setSessions(loadSessions(sessionsKey(user.id)))
      } else {
        // Token invalid/expired — clear storage
        localStorage.removeItem('talk_to_data_token')
        localStorage.removeItem('talk_to_data_user')
        setAuthUser(null)
      }
      setAuthLoading(false)
    })
  }, [])

  const handleAuth = (user) => {
    setAuthUser(user)
    setSessions(loadSessions(sessionsKey(user.id)))
    setAuthLoading(false)
  }

  const handleSignOut = () => {
    localStorage.removeItem('talk_to_data_token')
    localStorage.removeItem('talk_to_data_user')
    setAuthUser(null)
    setDomain(null)
    setSession(null)
    setMessages([])
    setSessions([])
    setFeedbacks({})
    currentLocalId.current = genLocalId()
  }

  // ── Session key helper ──────────────────────────────────────────────────────
  const myKey = () => sessionsKey(authUser?.id || 'anon')

  // ── Scroll + body class ─────────────────────────────────────────────────────
  useEffect(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), [messages, loading])
  useEffect(() => {
    document.body.classList.toggle('chat-active', messages.length > 0)
  }, [messages.length])

  // ── Persist session on message change ──────────────────────────────────────
  useEffect(() => {
    if (!messages.length || !domain || !authUser) return
    const userMsgs = messages.filter(m => m.role === 'user')
    if (!userMsgs.length) return
    const patch = {
      localId: currentLocalId.current,
      id: session?.session_id || null,
      name: session?.dataset || domain.label,
      domain,
      suggestions,
      datasets: session?.datasets?.map(d => d.name || d) || (session?.dataset ? [session.dataset] : []),
      messages: messages.map(m => ({ role: m.role, text: m.text, intent: m.intent })),
      messageCount: userMsgs.length,
      createdAt: sessions.find(s => s.localId === currentLocalId.current)?.createdAt || new Date().toISOString(),
      lastAt: new Date().toISOString(),
    }
    setSessions(prev => upsertSession(prev, patch, myKey()))
  }, [messages]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Suggestions ─────────────────────────────────────────────────────────────
  const matches = input.trim()
    ? suggestions.filter(s => s.toLowerCase().includes(input.trim().toLowerCase()))
    : suggestions
  const showSuggestionBox = focused && session && matches.length > 0

  // ── Data uploaded ───────────────────────────────────────────────────────────
  const handleDataUploaded = (res) => {
    setSession(res)
    if (Array.isArray(res.suggestions) && res.suggestions.length > 0) {
      setSuggestions(res.suggestions)
    }
  }

  // ── Core send logic ─────────────────────────────────────────────────────────
  const sendMessage = async (text, priorMessages) => {
    if (!text || loading) return
    if (!session) { setStatus('Upload a data file first.'); return }
    setLoading(true)

    const history = priorMessages.map(m => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: m.text,
    }))

    setMessages([
      ...priorMessages,
      { role: 'user', text },
      { role: 'assistant', text: '', figures: [], intent: null, streaming: true },
    ])

    const controller = new AbortController()
    abortRef.current = controller

    const patch = (fn) =>
      setMessages(m => {
        const msgs = [...m]
        const i = msgs.length - 1
        if (msgs[i]?.role === 'assistant') msgs[i] = fn(msgs[i])
        return msgs
      })

    try {
      await sendChatStream(
        session.session_id, text, history, domain?.id,
        (event) => {
          if (event.type === 'token') patch(msg => ({ ...msg, text: msg.text + event.text }))
          else if (event.type === 'figures') patch(msg => ({ ...msg, figures: event.figures }))
          else if (event.type === 'intent') patch(msg => ({ ...msg, intent: event.intent }))
          else if (event.type === 'done') { patch(msg => ({ ...msg, streaming: false })); setLoading(false) }
          else if (event.type === 'error') { patch(msg => ({ ...msg, text: `Error: ${event.text}`, streaming: false })); setLoading(false) }
        },
        controller.signal,
      )
    } catch (err) {
      if (err.name === 'AbortError') patch(msg => ({ ...msg, streaming: false }))
      else patch(msg => ({ ...msg, text: `Error: ${err.message}`, streaming: false }))
      setLoading(false)
    }
  }

  const send = () => { const t = input.trim(); if (!t) return; setInput(''); sendMessage(t, messages) }
  const stop = () => abortRef.current?.abort()

  const regenerate = (idx) => {
    if (loading) return
    const m = messages[idx]
    if (m?.role !== 'user') return
    sendMessage(m.text, messages.slice(0, idx))
  }

  const editMessage = (idx) => {
    if (loading) return
    const m = messages[idx]
    if (m?.role !== 'user') return
    setMessages(messages.slice(0, idx))
    setInput(m.text)
    inputRef.current?.focus()
  }

  const handleFeedback = async (msgIndex, type) => {
    const next = feedbacks[msgIndex] === type ? null : type
    setFeedbacks(prev => ({ ...prev, [msgIndex]: next }))
    if (next && session?.session_id) {
      await sendFeedback(session.session_id, msgIndex, next, messages[msgIndex - 1]?.text || '', messages[msgIndex]?.text || '')
    }
  }

  // ── Session management ──────────────────────────────────────────────────────
  const startNewSession = () => {
    currentLocalId.current = genLocalId()
    setSession(null); setMessages([]); setInput('')
    setFeedbacks({}); setSuggestions(DEFAULT_SUGGESTIONS)
    setStatus('Upload a CSV/Excel file to begin.')
  }

  const switchSession = (saved) => {
    currentLocalId.current = saved.localId
    setDomain(saved.domain)
    setMessages(saved.messages || [])
    setSuggestions(saved.suggestions || DEFAULT_SUGGESTIONS)
    setFeedbacks({})
    setSession(null)
    const fileList = saved.datasets?.length ? saved.datasets.join(', ') : 'your dataset'
    setStatus(`Chat restored. Re-upload ${fileList} to continue analysis.`)
    setInput('')
  }

  const deleteSession = (localId) => {
    setSessions(prev => removeSession(prev, localId, myKey()))
    if (localId === currentLocalId.current) startNewSession()
  }

  // ── Routing ─────────────────────────────────────────────────────────────────
  if (authLoading) return (
    <div className="auth-screen">
      <div className="auth-loading">
        <HeroGraphic size={64} />
        <p>Loading…</p>
      </div>
    </div>
  )

  if (!authUser) return <AuthPage onAuth={handleAuth} />
  if (!domain) return <DomainSelect onSelect={setDomain} />

  const resetDomain = () => {
    setDomain(null); setSession(null); setMessages([])
    setInput(''); setStatus('Upload a data file to begin.')
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="app">
      <HelpPanel />
      {showAdmin && <AdminPanel onClose={() => setShowAdmin(false)} />}

      <aside className="sidebar">
        <div className="brand">
          <HeroGraphic size={64} />
          <h1>Talk to Data</h1>
          <button className="domain-badge" onClick={resetDomain} title="Change domain">
            {domain.icon} {domain.label} ✕
          </button>
        </div>

        <FileUpload domain={domain} session={session} onDataUploaded={handleDataUploaded} onStatus={setStatus} />
        <JoinPanel session={session} onJoined={(res) => setSession(s => ({ ...s, datasets: res.datasets }))} onStatus={setStatus} />
        <p className="status">{status}</p>

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
                <div key={s.localId} className={`history-item ${s.localId === currentLocalId.current ? 'history-item--active' : ''}`}>
                  <button className="history-restore" onClick={() => switchSession(s)}>
                    <span className="history-icon">{s.domain?.icon || '📊'}</span>
                    <div className="history-meta">
                      <span className="history-name">{s.name || 'Untitled'}</span>
                      {s.datasets?.length > 0 && (
                        <span className="history-files">📎 {s.datasets.join(', ')}</span>
                      )}
                      <span className="history-info">{s.messageCount || 0} msgs · {fmtDate(s.lastAt)}</span>
                    </div>
                  </button>
                  <button className="history-delete" title="Delete" onClick={() => deleteSession(s.localId)}>✕</button>
                </div>
              ))}
            </div>
          )}
        </div>
      </aside>

      <div className="main">
        <div className="topbar">
          <span className="welcome-text">
            {authUser.role === 'admin' ? '👑 ' : ''}Welcome, {authUser.name}
          </span>
          <div className="topbar-actions">
            {authUser.role === 'admin' && (
              <button className="topbar-btn admin-btn-top" onClick={() => setShowAdmin(true)} title="Admin panel">
                👑 Admin
              </button>
            )}
            <button className="topbar-btn" onClick={handleSignOut} title="Sign out">
              ⎋ Sign Out
            </button>
          </div>
        </div>

        <main className="chat">
          {messages.length === 0 && (
            <div className="chat-empty">
              <p>Upload a dataset and ask anything about your data.</p>
            </div>
          )}

          {messages.map((m, i) => (
            <div key={i} className={`msg-wrapper ${m.role}`}>
              <div className={`msg ${m.role}`}>
                {m.intent && m.intent !== 'chitchat' && (
                  <span className={`intent-chip ${m.intent}`}>
                    {{ data_analysis: 'Data analysis', knowledge_lookup: 'Knowledge base (RAG)', hybrid: 'Data + RAG' }[m.intent]}
                  </span>
                )}
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.text}</ReactMarkdown>
                {m.streaming && m.text && <span className="cursor-blink">▋</span>}
                {m.figures?.map((fig, j) => <PlotlyChart key={j} figure={fig} />)}
              </div>

              {m.role === 'user' && (
                <div className="msg-actions msg-actions--user">
                  <button className="msg-action-btn" title="Edit message" onClick={() => editMessage(i)} disabled={loading}>
                    ✏️ Edit
                  </button>
                  <button className="msg-action-btn" title="Regenerate response" onClick={() => regenerate(i)} disabled={loading}>
                    🔄 Retry
                  </button>
                </div>
              )}

              {m.role === 'assistant' && !m.streaming && m.text && (
                <div className="feedback-row">
                  <button className={`feedback-btn up ${feedbacks[i] === 'up' ? 'active' : ''}`} title="Good response" onClick={() => handleFeedback(i, 'up')}>👍</button>
                  <button className={`feedback-btn down ${feedbacks[i] === 'down' ? 'active' : ''}`} title="Poor response" onClick={() => handleFeedback(i, 'down')}>👎</button>
                  {feedbacks[i] && (
                    <span className="feedback-thanks">{feedbacks[i] === 'up' ? 'Thanks for the feedback!' : "We'll use this to improve."}</span>
                  )}
                </div>
              )}
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
                <button key={s} className="suggestion" onMouseDown={e => { e.preventDefault(); setInput(s) }}>{s}</button>
              ))}
            </div>
          )}
          <input
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={e => e.key === 'Enter' && !loading && send()}
            placeholder="Ask about your data — analysis, charts, or why something happened…"
            disabled={loading}
          />
          {loading
            ? <button className="stop-btn" onClick={stop} title="Stop generation">⏹ Stop</button>
            : <button onClick={send} disabled={!input.trim()}>Send</button>
          }
        </footer>
      </div>
    </div>
  )
}
