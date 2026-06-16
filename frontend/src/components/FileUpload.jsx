import { useRef, useState } from 'react'
import { confirmUpload, uploadData, uploadDocs } from '../api'

const DATA_EXTS = /\.(csv|xlsx|xls)$/i

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
    const all = [...e.target.files]
    const files = all.filter(f => DATA_EXTS.test(f.name))

    if (!files.length) {
      onStatus('No CSV or Excel files found in the selected folder.')
      e.target.value = ''
      return
    }

    setBusy(true)
    setFolderProgress({ done: 0, total: files.length, name: '' })

    let lastRes = null
    let sid = session?.session_id
    let successCount = 0
    let errors = []

    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      setFolderProgress({ done: i, total: files.length, name: file.name })
      onStatus(`Uploading ${i + 1}/${files.length}: ${file.name}…`)

      try {
        const res = await uploadData(file, sid, domain?.id)
        sid = res.session_id   // keep same session across all files

        if (res.pii_detected) {
          // Auto-proceed raw for folder uploads to avoid blocking the batch
          const confirmed = await confirmUpload(res.pending_id, 'proceed')
          lastRes = confirmed
        } else {
          lastRes = res
        }
        successCount++
      } catch (err) {
        errors.push(`${file.name}: ${err.message}`)
      }
    }

    setFolderProgress(null)

    if (lastRes) {
      onDataUploaded(lastRes)
      const errNote = errors.length ? ` (${errors.length} failed)` : ''
      onStatus(`Loaded ${successCount}/${files.length} files from folder${errNote}. Active dataset: '${lastRes.dataset}'.`)
    } else {
      onStatus(`All uploads failed: ${errors.join('; ')}`)
    }

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
