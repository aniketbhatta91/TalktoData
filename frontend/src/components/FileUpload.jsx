import { useEffect, useRef, useState } from 'react'
import { confirmUpload, uploadData, uploadDocs } from '../api'

const DATA_EXTS = /\.(csv|xlsx|xls|tsv|json)$/i
const DOC_EXTS  = /\.(pdf|docx|doc|txt|md|pptx|ppt)$/i
const MAX_FILE_MB = 100

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** Build a plain-text folder index so the LLM knows every file name + type */
function buildFolderIndex(allFiles) {
  const lines = [
    `Folder Upload — ${allFiles.length} file(s) found`,
    `Uploaded: ${new Date().toLocaleString()}`,
    '',
    'File listing:',
    ...allFiles.map((f, i) =>
      `${i + 1}. ${f.webkitRelativePath || f.name}  (${fmtSize(f.size)}, ${f.type || 'unknown type'})`
    ),
    '',
    'Data files (CSV/Excel/TSV/JSON) are loaded into the analysis engine.',
    'Document files (PDF/DOCX/TXT/MD) are indexed into the knowledge base.',
  ]
  return new File([lines.join('\n')], '_folder_index.txt', { type: 'text/plain' })
}

/**
 * Build a CSV manifest of every file in the folder.
 * Uploaded as a DATA file so the LLM can query file names with Python/pandas.
 *
 * Columns:
 *   filename          — e.g. "John_Smith_AWS_Cert.pdf"
 *   name_without_ext  — e.g. "John_Smith_AWS_Cert"  (easy to split/parse)
 *   filepath          — relative path including subfolders
 *   size_kb           — file size in KB
 *   extension         — file extension without dot
 *   file_type         — "data" | "document" | "other"
 */
function buildManifestCSV(allFiles) {
  const esc = v => `"${String(v).replace(/"/g, '""')}"`
  const header = 'filename,name_without_ext,filepath,size_kb,extension,file_type'
  const rows = allFiles.map(f => {
    const dotIdx = f.name.lastIndexOf('.')
    const nameNoExt = dotIdx > 0 ? f.name.slice(0, dotIdx) : f.name
    const ext = dotIdx > 0 ? f.name.slice(dotIdx + 1).toLowerCase() : ''
    const filepath = f.webkitRelativePath || f.name
    const isData = DATA_EXTS.test(f.name)
    const isDoc  = DOC_EXTS.test(f.name)
    const ftype  = isData ? 'data' : isDoc ? 'document' : 'other'
    return [
      esc(f.name),
      esc(nameNoExt),
      esc(filepath),
      (f.size / 1024).toFixed(2),
      esc(ext),
      esc(ftype),
    ].join(',')
  })
  const csv = [header, ...rows].join('\n')
  return new File([csv], '_folder_manifest.csv', { type: 'text/csv' })
}

export default function FileUpload({ domain, session, onDataUploaded, onStatus }) {
  const dataAccept = domain?.dataAccept || '.csv,.xlsx,.xls'
  const docsAccept = domain?.docsAccept || '.pdf,.docx,.xlsx,.xls,.csv,.txt,.md'

  const dataRef   = useRef(null)
  const folderRef = useRef(null)
  const docsRef   = useRef(null)

  const [busy, setBusy] = useState(false)
  const [pendingPii, setPendingPii] = useState(null)
  const [folderProgress, setFolderProgress] = useState(null)
  const [folderFiles, setFolderFiles] = useState(null)   // preview before upload

  // Apply webkitdirectory reliably via DOM attribute (React strips unknown props)
  useEffect(() => {
    if (folderRef.current) {
      folderRef.current.setAttribute('webkitdirectory', '')
      folderRef.current.setAttribute('multiple', '')
    }
  }, [])

  /* ── single data file ───────────────────────────────────────────────────── */
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

  /* ── docs ───────────────────────────────────────────────────────────────── */
  const handleDocs = async (e) => {
    const files = [...e.target.files]
    if (!files.length) return
    setBusy(true)
    try {
      const res = await uploadDocs(files, domain?.id)
      const total = res.ingested.reduce((s, r) => s + (r.chunks_indexed || 0), 0)
      onStatus(`Indexed ${total} chunks from ${files.length} document(s).`)
    } catch (err) {
      onStatus(`Error: ${err.message}`)
    } finally {
      setBusy(false)
      e.target.value = ''
    }
  }

  /* ── folder scan (show preview first) ──────────────────────────────────── */
  const handleFolderScan = (e) => {
    const all = [...e.target.files].filter(
      f => !f.name.startsWith('.') && !f.name.startsWith('~$')
    )
    if (!all.length) {
      onStatus('No files found in the selected folder.')
      e.target.value = ''
      return
    }
    // Show preview panel — user clicks "Process folder" to actually upload
    setFolderFiles(all)
  }

  const processFolderFiles = async () => {
    if (!folderFiles?.length) return
    const all = folderFiles
    const maxBytes = MAX_FILE_MB * 1024 * 1024

    const dataFiles = all.filter(f => DATA_EXTS.test(f.name) && f.size <= maxBytes)
    const docFiles  = all.filter(f => DOC_EXTS.test(f.name)  && f.size <= maxBytes)
    const tooBig    = all.filter(f => f.size > maxBytes)

    // +1 for manifest CSV, +1 for doc batch (if any)
    const total = 1 + dataFiles.length + (docFiles.length ? 1 : 0)
    setBusy(true)
    setFolderFiles(null)
    setFolderProgress({ done: 0, total, name: 'Building file manifest…' })

    let lastDataRes = null
    let sid = session?.session_id
    let dataOk = 0
    const errors = []

    // ── 1a. Upload manifest CSV as a DATA file ────────────────────────────
    //    This gives the LLM a pandas DataFrame where every row is a file.
    //    The LLM can then parse filenames with Python to build tables.
    try {
      const manifestFile = buildManifestCSV(all)
      const manifestRes = await uploadData(manifestFile, sid, domain?.id)
      sid = manifestRes.session_id   // carry session forward
      if (manifestRes.pii_detected) {
        // filenames are never real PII — just proceed
        const confirmed = await confirmUpload(manifestRes.pending_id, 'proceed')
        lastDataRes = confirmed
      } else {
        lastDataRes = manifestRes
      }
    } catch (e) {
      console.warn('Manifest upload failed:', e)
    }

    // ── 1b. Upload plain-text folder index into RAG docs ─────────────────
    try {
      const indexFile = buildFolderIndex(all)
      await uploadDocs([indexFile], domain?.id)
    } catch { /* non-critical */ }

    // ── 2. Data files one by one ─────────────────────────────────────────
    for (let i = 0; i < dataFiles.length; i++) {
      const file = dataFiles[i]
      setFolderProgress({ done: 1 + i, total, name: file.webkitRelativePath || file.name })
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

    // ── 3. Doc files as one batch ────────────────────────────────────────
    let docChunks = 0
    if (docFiles.length) {
      setFolderProgress({ done: 1 + dataFiles.length, total, name: `${docFiles.length} document(s)` })
      onStatus(`Indexing ${docFiles.length} document(s)…`)
      try {
        const res = await uploadDocs(docFiles, domain?.id)
        docChunks = res.ingested?.reduce((s, r) => s + (r.chunks_indexed || 0), 0) || 0
      } catch (err) {
        errors.push(`Docs: ${err.message}`)
      }
    }

    setFolderProgress(null)
    if (lastDataRes) onDataUploaded(lastDataRes)

    // ── 4. Status summary ────────────────────────────────────────────────
    const parts = []
    if (dataOk)        parts.push(`${dataOk} data file${dataOk > 1 ? 's' : ''} loaded`)
    if (docChunks)     parts.push(`${docChunks} doc chunks indexed`)
    if (errors.length) parts.push(`${errors.length} error(s)`)
    if (tooBig.length) parts.push(`${tooBig.length} skipped (over ${MAX_FILE_MB} MB)`)

    onStatus(parts.join(' · ') || 'Folder processed.')
    setBusy(false)
    // reset file input so the same folder can be re-selected
    if (folderRef.current) folderRef.current.value = ''
  }

  /* ── render ─────────────────────────────────────────────────────────────── */
  return (
    <div className="upload-bar">
      <input ref={dataRef}   type="file" accept={dataAccept} hidden onChange={handleData} />
      <input ref={docsRef}   type="file" accept={docsAccept} multiple hidden onChange={handleDocs} />
      <input ref={folderRef} type="file" hidden onChange={handleFolderScan} />

      <button className="upload-btn" disabled={busy} onClick={() => dataRef.current.click()}>
        📄 {session ? 'Add data file' : 'Upload CSV / Excel'}
      </button>

      <button className="upload-btn upload-btn--folder" disabled={busy}
              onClick={() => folderRef.current.click()}>
        📂 Upload folder
      </button>

      <button className="upload-btn upload-btn--docs" disabled={busy}
              onClick={() => docsRef.current.click()}>
        📚 Upload docs (RAG)
      </button>

      {/* Folder file preview */}
      {folderFiles && (
        <div className="folder-preview">
          <div className="folder-preview-header">
            <span>📂 {folderFiles.length} file(s) found</span>
            <button className="folder-preview-close" onClick={() => setFolderFiles(null)}>✕</button>
          </div>
          <div className="folder-preview-list">
            {folderFiles.map((f, i) => {
              const isData = DATA_EXTS.test(f.name)
              const isDoc  = DOC_EXTS.test(f.name)
              const tag    = isData ? '📊' : isDoc ? '📄' : '⚠️'
              const label  = isData ? 'data' : isDoc ? 'doc' : 'skip'
              return (
                <div key={i} className={`folder-file-row ${label}`}>
                  <span className="folder-file-icon">{tag}</span>
                  <span className="folder-file-name" title={f.webkitRelativePath || f.name}>
                    {f.webkitRelativePath || f.name}
                  </span>
                  <span className="folder-file-size">{fmtSize(f.size)}</span>
                  <span className={`folder-file-tag ${label}`}>{label}</span>
                </div>
              )
            })}
          </div>
          <div className="folder-preview-footer">
            <span className="folder-preview-legend">
              📊 → analysis &nbsp;·&nbsp; 📄 → knowledge base &nbsp;·&nbsp; ⚠️ → skipped
            </span>
            <button className="folder-process-btn" onClick={processFolderFiles} disabled={busy}>
              ⚡ Process folder
            </button>
          </div>
        </div>
      )}

      {/* Folder upload progress */}
      {folderProgress && (
        <div className="folder-progress">
          <div className="folder-progress-bar"
               style={{ width: `${(folderProgress.done / folderProgress.total) * 100}%` }} />
          <span className="folder-progress-label">
            {folderProgress.done}/{folderProgress.total} · {folderProgress.name}
          </span>
        </div>
      )}

      {/* PII warning */}
      {pendingPii && (
        <div className="pii-warning">
          <h3>Sensitive data detected</h3>
          <ul>{pendingPii.findings.map(f => (
            <li key={f.column}><strong>{f.column}</strong>: {f.types.join(', ')}</li>
          ))}</ul>
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
          {session.datasets.map(d => (
            <span key={d.name} className="dataset-chip" title={d.columns?.join(', ')}>
              {d.name} · {d.rows} rows
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
