const MAX_SESSIONS = 20
const STORAGE_KEY = 'talk_to_data_sessions'

/* ── helpers ─────────────────────────────────────────────────────────────── */
export function loadSessions() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')
  } catch {
    return []
  }
}

function saveSessions(sessions) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions.slice(0, MAX_SESSIONS)))
  } catch { /* storage full — skip */ }
}

export function upsertSession(sessions, patch) {
  // patch must contain localId
  const idx = sessions.findIndex(s => s.localId === patch.localId)
  const updated = idx >= 0
    ? sessions.map((s, i) => i === idx ? { ...s, ...patch } : s)
    : [patch, ...sessions]          // newest first
  saveSessions(updated)
  return updated
}

export function removeSession(sessions, localId) {
  const updated = sessions.filter(s => s.localId !== localId)
  saveSessions(updated)
  return updated
}

export function genLocalId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
}

/* ── date formatter ──────────────────────────────────────────────────────── */
function fmt(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const now = new Date()
  const diffMs = now - d
  const diffMin = Math.floor(diffMs / 60000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const diffH = Math.floor(diffMin / 60)
  if (diffH < 24) return `${diffH}h ago`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/* ── UI component ────────────────────────────────────────────────────────── */
export default function SessionsPanel({ open, sessions, currentLocalId, onSwitch, onDelete, onClose, onNewSession }) {
  if (!open) return null

  return (
    <>
      <div className="sessions-backdrop" onClick={onClose} />
      <div className="sessions-drawer">
        <div className="sessions-head">
          <span>🕐 Chat History</span>
          <button className="sessions-close" onClick={onClose}>✕</button>
        </div>

        <button className="sessions-new-btn" onClick={() => { onNewSession(); onClose() }}>
          + New Session
        </button>

        {sessions.length === 0 && (
          <p className="sessions-empty">No saved sessions yet.<br />Upload a dataset and start chatting to begin.</p>
        )}

        <div className="sessions-list">
          {sessions.map(s => (
            <div key={s.localId} className={`session-item ${s.localId === currentLocalId ? 'session-item--active' : ''}`}>
              <button className="session-restore" onClick={() => { onSwitch(s); onClose() }}>
                <span className="session-icon">{s.domain?.icon || '📊'}</span>
                <div className="session-meta">
                  <span className="session-name">{s.name || 'Untitled session'}</span>
                  <span className="session-info">
                    {s.domain?.label} · {s.messageCount || 0} messages · {fmt(s.lastAt)}
                  </span>
                </div>
              </button>
              <button
                className="session-delete"
                title="Delete session"
                onClick={() => onDelete(s.localId)}
              >
                🗑
              </button>
            </div>
          ))}
        </div>

        <p className="sessions-note">
          💡 Sessions restore chat history. Re-upload your dataset to continue analysis.
        </p>
      </div>
    </>
  )
}
