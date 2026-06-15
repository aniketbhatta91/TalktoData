// dev: talk to uvicorn on :8000; production build: same origin as the page
const BASE = import.meta.env.DEV ? 'http://localhost:8000' : ''

export async function uploadData(file, sessionId, domain) {
  const fd = new FormData()
  fd.append('file', file)
  if (sessionId) fd.append('session_id', sessionId)
  if (domain) fd.append('domain', domain)
  const res = await fetch(`${BASE}/api/upload/data`, { method: 'POST', body: fd })
  if (!res.ok) throw new Error((await res.json()).detail || 'Upload failed')
  return res.json()
}

export async function getSettings() {
  const res = await fetch(`${BASE}/api/settings`)
  if (!res.ok) throw new Error('Could not load settings')
  return res.json()
}

export async function saveSettings(settings, reset = false) {
  const res = await fetch(`${BASE}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings, reset }),
  })
  if (!res.ok) throw new Error('Could not save settings')
  return res.json()
}

export async function confirmUpload(pendingId, action) {
  const res = await fetch(`${BASE}/api/upload/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pending_id: pendingId, action }),
  })
  if (!res.ok) throw new Error((await res.json()).detail || 'Confirm failed')
  return res.json()
}

export async function joinDatasets(sessionId, left, right, how, on) {
  const res = await fetch(`${BASE}/api/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId, left, right, how, on }),
  })
  if (!res.ok) throw new Error((await res.json()).detail || 'Join failed')
  return res.json()
}

export async function uploadDocs(files, domain) {
  const fd = new FormData()
  for (const f of files) fd.append('files', f)
  if (domain) fd.append('domain', domain)
  const res = await fetch(`${BASE}/api/upload/docs`, { method: 'POST', body: fd })
  if (!res.ok) throw new Error('Document upload failed')
  return res.json()
}

export async function sendChat(sessionId, message, history, domain) {
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId, message, history, domain: domain || '' }),
  })
  if (!res.ok) throw new Error((await res.json()).detail || 'Chat failed')
  return res.json()
}

/**
 * Streaming chat via SSE. Calls onEvent for each parsed event dict.
 * Event types: intent | status | token | figures | done | error
 */
export async function sendChatStream(sessionId, message, history, domain, onEvent) {
  const res = await fetch(`${BASE}/api/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId, message, history, domain: domain || '' }),
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

      // Process complete SSE blocks (delimited by \n\n)
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
