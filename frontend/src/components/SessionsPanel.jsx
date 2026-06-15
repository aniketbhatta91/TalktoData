const MAX_SESSIONS = 20
const DEFAULT_KEY = 'talk_to_data_sessions'

/* ── helpers (key is per-user: talk_to_data_sessions_<userId>) ─────────────── */
export function loadSessions(key = DEFAULT_KEY) {
  try { return JSON.parse(localStorage.getItem(key) || '[]') } catch { return [] }
}

function saveSessions(sessions, key = DEFAULT_KEY) {
  try { localStorage.setItem(key, JSON.stringify(sessions.slice(0, MAX_SESSIONS))) } catch { /* full */ }
}

export function upsertSession(sessions, patch, key = DEFAULT_KEY) {
  const idx = sessions.findIndex(s => s.localId === patch.localId)
  const updated = idx >= 0
    ? sessions.map((s, i) => i === idx ? { ...s, ...patch } : s)
    : [patch, ...sessions]
  saveSessions(updated, key)
  return updated
}

export function removeSession(sessions, localId, key = DEFAULT_KEY) {
  const updated = sessions.filter(s => s.localId !== localId)
  saveSessions(updated, key)
  return updated
}

export function genLocalId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
}
