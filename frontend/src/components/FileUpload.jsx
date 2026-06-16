import { useRef, useState } from 'react'
import { confirmUpload, uploadData, uploadDocs } from '../api'

const DATA_EXTS = /\.(csv|xlsx|xls|tsv)$/i
const DOC_EXTS  = /\.(pdf|docx|doc|txt|md|pptx|ppt|json)$/i
const MAX_FILE_MB = 100

export default function FileUpload({ domain, session, onDataUploaded, onStatus }) {
  const dataAccept = domain?.dataAccept || '.csv,.xlsx,.xls'
  const docsAccept = domain?.docsAccept || '.pdf,.docx,.xlsx,.xls,.csv,.txt,.md'

  const dataRef   = useRef(null)
  const folderRef = useRef(null)
  const docsRef   = useRef(null)

  const [busy, setBusy] = useState(false)
  const [pendingPii, setPendingPii] = useState(null)
  const [folderProgress, setFolderProgress] = useState(null)  // { done, total, name }

  /* ── single file upload ─────────────────────────────────────────────────── */
  const finish = (res, prefix = '') => {
    onDataUploaded(res)
    onStatus(`${prefix}Added '${res.dataset}'. ${res.data_summaries_indexed} summaries indexed.`)
  }

  const handleData = async (e) => {
    const file = e.target.files[0]
    if (!file) return
    setBusy(true)
    try {
      const res = await uploadData(file, session?.session_id, domain?.id)
      if (res.pii_detected) {
        setPendingPii(res)
        onStatus('Sensitive data detected — choose how to continue.')
      } else {
        finish(res)
      }
    } catch (err) {
      onStatus(`Error: ${err.message}`)
    } finally {
      setBusy(false)
      e.target.value = ''
    }
  }

  const resolvePii = async (action) => {
    setBusy(true)
    try {
      const res = await confirmUpload(pendingPii.pending_id, action)
      setPendingPii(null)
      finish(res, action === 'mask' ? 'PII masked. ' : 'Proceeded with raw data. ')
    } catch (err) {
      onStatus(`Error: ${err.message}`)
    } finally {
      setBusy(false)
    }
  }

  /* ── folder upload ──────────────────────────────────────────────────────── */
  const handleFolder = async (e) => {
    const maxBytes = MAX_FILE_MB * 1024 * 1024
    const all = [...e.target.files].filter(f => !f.name.startsWith('.') && !f.name.startsWith('~'))

    // Route by type
    const dataFiles = all.filter(f => DATA_EXTS.test(f.name) && f.size <= maxBytes)
    const docFiles  = all.filter(f => DOC_EXTS.test(f.name)  && f.size <= maxBytes)
    const tooBig    = all.filter(f => f.size > maxBytes)
    const skipped   = all.filter(f => !DATA_EXTS.test(f.name) && !DOC_EXTS.test(f.name) && f.size <= maxBytes)

    if (!dataFiles.length && !docFiles.length) {
      const note = tooBig.length ? ` (${tooBig.length} files exceeded ${MAX_FILE_MB} MB limit)` : ''
      onStatus(`No supported files found in folder${note}. Supported: CSV, Excel, TSV, PDF, DOCX, TXT, MD, JSON.`)
      e.target.value = ''
      return
    }

    const total = dataFiles.length + docFiles.length
    setBusy(true)
    setFolderProgress({ done: 0, total, name: '' })

    let lastDataRes = null
    let sid = session?.session_id
    let dataOk = 0
    const errors = []

    // ── 1. Upload data files one by one ────────────────────────────────────
    for (let i = 0; i < dataFiles.length; i++) {
      const file = dataFiles[i]
      setFolderProgress({ done: i, total, name: file.name })
      onStatus(`Data ${i + 1}/${dataFiles.length}: ${file.name}…`)
      try {
        const res = await uploadData(file, sid, domain?.id)
        sid = res.session_id
        if (res.pii_detected) {
          const confirmed = await confirmUpload(res.pending_id, 'proceed')
          lastDataRes = confirmed
        } else {
          lastDataRes = res
        }
        dataOk++
      } catch (err) {
        errors.push(`${file.name}: ${err.message}`)
      }
    }

    // ── 2. Upload doc files as a single batch ───────────────────────────────
    let docChunks = 0
    if (docFiles.length) {
      setFolderProgress({ done: dataFiles.length, total, name: `${docFiles.length} document(s)…` })
      onStatus(`Indexing ${docFiles.length} document(s) into knowledge base…`)
      try {
        const res = await uploadDocs(docFiles, domain?.id)
        docChunks = res.ingested?.reduce((s, r) => s + (r.chunks_indexed || 0), 0) || 0
      } catch (err) {
        errors.push(`Documents: ${err.message}`)
      }
    }

    setFolderProgress(null)

    // ── 3. Report ───────────────────────────────────────────────────────────
    if (lastDataRes) onDataUploaded(lastDataRes)

    const parts = []
    if (dataOk)      parts.push(`${dataOk} data file${dataOk > 1 ? 's' : ''} loaded`)
    if (docChunks)   parts.push(`${docChunks} doc chunks indexed`)
    if (errors.length) parts.push(`${errors.length} failed`)
    if (tooBig.length) parts.push(`${tooBig.length} skipped (over ${MAX_FILE_MB} MB)`)
    if (skipped.length) parts.push(`${skipped.length} unsupported type skipped`)

    onStatus(parts.join(' · ') || 'Folder processed.')
    setBusy(false)
    e.target.value = ''
  }

  /* ── doc upload ─────────────────────────────────────────────────────────── */
  const handleDocs = async (e) => {
    const files = [...e.target.files]
    if (!files.length) return
    setBusy(true)
    try {
      const res = await uploadDocs(files, domain?.id)
      const total = res.ingested.reduce((s, r) => s + (r.chunks_indexed || 0), 0)
      onStatus(`Indexed ${total} chunks from ${files.length} document(s) into knowledge base.`)
    } catch (err) {
      onStatus(`Error: ${err.message}`)
    } finally {
      setBusy(false)
      e.target.value = ''
    }
  }

  return (
    <div className="upload-bar">
      {/* Hidden inputs */}
      <input ref={dataRef}   type="file" accept={dataAccept} hidden onChange={handleData} />
      <input ref={docsRef}   type="file" accept={docsAccept} multiple hidden onChange={handleDocs} />
      {/* webkitdirectory lets the user pick a whole folder */}
      <input ref={folderRef} type="file" hidden onChange={handleFolder}
             {...{ webkitdirectory: '', mozdirectory: '', directory: '' }} />

      {/* Single file */}
      <button className="upload-btn" disabled={busy} onClick={() => dataRef.current.click()}>
        📄 {session ? 'Add data file' : `Upload CSV / Excel`}
      </button>

      {/* Folder */}
      <button className="upload-btn upload-btn--folder" disabled={busy} onClick={() => folderRef.current.click()}>
        📂 Upload folder
      </button>

      {/* Folder progress bar */}
      {folderProgress && (
        <div className="folder-progress">
          <div className="folder-progress-bar" style={{ width: `${(folderProgress.done / folderProgress.total) * 100}%` }} />
          <span className="folder-progress-label">
            {folderProgress.done}/{folderProgress.total} · {folderProgress.name}
          </span>
        </div>
      )}

      {/* Context docs */}
      <button className="upload-btn upload-btn--docs" disabled={busy} onClick={() => docsRef.current.click()}>
        📚 Upload docs (RAG)
      </button>

      {/* PII warning */}
      {pendingPii && (
        <div className="pii-warning">
          <h3>Sensitive data detected</h3>
          <ul>
            {pendingPii.findings.map((f) => (
              <li key={f.column}><strong>{f.column}</strong>: {f.types.join(', ')}</li>
            ))}
          </ul>
          <p>Mask it before analysis, or proceed with the raw values?</p>
          <div className="pii-actions">
            <button disabled={busy} className="mask"    onClick={() => resolvePii('mask')}>Mask PII (safe)</button>
            <button disabled={busy} className="proceed" onClick={() => resolvePii('proceed')}>Proceed raw</button>
          </div>
        </div>
      )}

      {/* Loaded datasets */}
      {session?.datasets?.length > 0 && (
        <div className="dataset-list">
          {session.datasets.map((d) => (
            <span key={d.name} className="dataset-chip" title={d.columns?.join(', ')}>
              {d.name} · {d.rows} rows
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
