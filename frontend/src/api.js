// dev: talk to uvicorn on :8000; production build: same origin as the page
const BASE = import.meta.env.DEV ? 'http://localhost:8000' : ''

/** Returns Authorization header if a token is stored. */
function authHeader() {
  const token = localStorage.getItem('talk_to_data_token')
  return token ? { Authorization: `Bearer ${token}` } : {}
}

// ── Auth ─────────────────────────────────────────────────────────────────────

export async function signUp(name, email, password) {
  const res = await fetch(`${BASE}/api/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, email, password }),
  })
  if (!res.ok) throw new Error((await res.json()).detail || 'Sign-up failed')
  return res.json()
}

export async function signIn(email, password) {
  const res = await fetch(`${BASE}/api/auth/signin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (!res.ok) throw new Error((await res.json()).detail || 'Sign-in failed')
  return res.json()   // { token, user }
}

export async function getMe() {
  const res = await fetch(`${BASE}/api/auth/me`, {
    headers: { ...authHeader() },
  })
  if (!res.ok) return null
  return res.json()
}

// ── Admin ─────────────────────────────────────────────────────────────────────

export async function listUsers() {
  const res = await fetch(`${BASE}/api/admin/users`, {
    headers: { ...authHeader() },
  })
  if (!res.ok) throw new Error((await res.json()).detail || 'Failed to load users')
  return res.json()   // { users: [...] }
}

export async function updateUserStatus(userId, status) {
  const res = await fetch(`${BASE}/api/admin/users/${userId}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body: JSON.stringify({ status }),
  })
  if (!res.ok) throw new Error((await res.json()).detail || 'Failed to update status')
  return res.json()
}

// ── Data upload ───────────────────────────────────────────────────────────────

export async function uploadData(file, sessionId, domain) {
  const fd = new FormData()
  fd.append('file', file)
  if (sessionId) fd.append('session_id', sessionId)
  if (domain) fd.append('domain', domain)
  const res = await fetch(`${BASE}/api/upload/data`, {
    method: 'POST',
    headers: { ...authHeader() },
    body: fd,
  })
  if (!res.ok) throw new Error((await res.json()).detail || 'Upload failed')
  return res.json()
}

export async function getSettings() {
  const res = await fetch(`${BASE}/api/settings`, { headers: { ...authHeader() } })
  if (!res.ok) throw new Error('Could not load settings')
  return res.json()
}

export async function saveSettings(settings, reset = false) {
  const res = await fetch(`${BASE}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body: JSON.stringify({ settings, reset }),
  })
  if (!res.ok) throw new Error('Could not save settings')
  return res.json()
}

export async function confirmUpload(pendingId, action) {
  const res = await fetch(`${BASE}/api/upload/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body: JSON.stringify({ pending_id: pendingId, action }),
  })
  if (!res.ok) throw new Error((await res.json()).detail || 'Confirm failed')
  return res.json()
}

export async function joinDatasets(sessionId, left, right, how, on) {
  const res = await fetch(`${BASE}/api/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body: JSON.stringify({ session_id: sessionId, left, right, how, on }),
  })
  if (!res.ok) throw new Error((await res.json()).detail || 'Join failed')
  return res.json()
}

export async function uploadDocs(files, domain) {
  const fd = new FormData()
  for (const f of files) fd.append('files', f)
  if (domain) fd.append('domain', domain)
  const res = await fetch(`${BASE}/api/upload/docs`, {
    method: 'POST',
    headers: { ...authHeader() },
    body: fd,
  })
  if (!res.ok) throw new Error('Document upload failed')
  return res.json()
}

export async function sendChat(sessionId, message, history, domain) {
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body: JSON.stringify({ session_id: sessionId, message, history, domain: domain || '' }),
  })
  if (!res.ok) throw new Error((await res.json()).detail || 'Chat failed')
  return res.json()
}

/**
 * Streaming chat via SSE. Calls onEvent for each parsed event dict.
 * Event types: intent | status | token | figures | done | error
 */
export async function sendChatStream(sessionId, message, history, domain, onEvent, signal) {
  const res = await fetch(`${BASE}/api/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body: JSON.stringify({ session_id: sessionId, message, history, domain: domain || '' }),
    signal,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: 'Stream failed' }))
    throw new Error(err.detail || 'Chat stream failed')
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let boundary
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        for (const line of block.split('\n')) {
          if (line.startsWith('data: ')) {
            try {
              const event = JSON.parse(line.slice(6))
              onEvent(event)
              if (event.type === 'done' || event.type === 'error') return
            } catch { /* skip malformed lines */ }
          }
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

/** Submit thumbs-up / thumbs-down feedback. Best-effort — never throws. */
export async function sendFeedback(sessionId, messageIndex, feedback, userMessage, assistantMessage) {
  try {
    await fetch(`${BASE}/api/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify({
        session_id: sessionId,
        message_index: messageIndex,
        feedback,
        user_message: userMessage,
        assistant_message: assistantMessage,
      }),
    })
  } catch { /* best-effort */ }
}
