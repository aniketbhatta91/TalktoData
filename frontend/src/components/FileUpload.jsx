import { useRef, useState } from 'react'
import { confirmUpload, uploadData, uploadDocs } from '../api'

export default function FileUpload({ domain, session, onDataUploaded, onStatus }) {
  const dataAccept = domain?.dataAccept || '.csv,.xlsx,.xls'
  const docsAccept = domain?.docsAccept || '.pdf,.docx,.xlsx,.xls,.csv,.txt,.md'
  const dataRef = useRef(null)
  const docsRef = useRef(null)
  const [busy, setBusy] = useState(false)
  const [pendingPii, setPendingPii] = useState(null) // {pending_id, findings}

  const finish = (res, prefix = '') => {
    onDataUploaded(res)
    onStatus(`${prefix}Added '${res.dataset}'. ${res.data_summaries_indexed} data summaries indexed for RAG.`)
  }

  const handleData = async (e) => {
    const file = e.target.files[0]
    if (!file) return
    setBusy(true)
    try {
      const res = await uploadData(file, session?.session_id, domain?.id)
      if (res.pii_detected) {
        setPendingPii(res)
        onStatus('Sensitive data detected - choose how to continue.')
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

  const handleDocs = async (e) => {
    const files = [...e.target.files]
    if (!files.length) return
    setBusy(true)
    try {
      const res = await uploadDocs(files, domain?.id)
      const total = res.ingested.reduce((s, r) => s + (r.chunks_indexed || 0), 0)
      onStatus(`Indexed ${total} chunks from ${files.length} document(s) into the knowledge base.`)
    } catch (err) {
      onStatus(`Error: ${err.message}`)
    } finally {
      setBusy(false)
      e.target.value = ''
    }
  }

  return (
    <div className="upload-bar">
      <input ref={dataRef} type="file" accept={dataAccept} hidden onChange={handleData} />
      <input ref={docsRef} type="file" accept={docsAccept} multiple hidden onChange={handleDocs} />
      <button disabled={busy} onClick={() => dataRef.current.click()}>
        {session ? '+ Add another data file' : `Upload data (${dataAccept.replaceAll('.', ' ').trim()})`}
      </button>
      <button disabled={busy} onClick={() => docsRef.current.click()}>
        Upload context docs (RAG)
      </button>
      {pendingPii && (
        <div className="pii-warning">
          <h3>Sensitive data detected</h3>
          <ul>
            {pendingPii.findings.map((f) => (
              <li key={f.column}>
                <strong>{f.column}</strong>: {f.types.join(', ')}
              </li>
            ))}
          </ul>
          <p>Mask it before analysis, or proceed with the raw values?</p>
          <div className="pii-actions">
            <button disabled={busy} className="mask" onClick={() => resolvePii('mask')}>
              Mask PII (safe)
            </button>
            <button disabled={busy} className="proceed" onClick={() => resolvePii('proceed')}>
              Proceed raw
            </button>
          </div>
        </div>
      )}
      {session?.datasets?.length > 0 && (
        <div className="dataset-list">
          {session.datasets.map((d) => (
            <span key={d.name} className="dataset-chip" title={d.columns.join(', ')}>
              {d.name} · {d.rows} rows
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
