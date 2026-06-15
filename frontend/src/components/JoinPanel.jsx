import { useMemo, useState } from 'react'
import { joinDatasets } from '../api'

const JOIN_TYPES = [
  { value: 'inner', label: 'Inner — only matching rows' },
  { value: 'left', label: 'Left — all rows from left' },
  { value: 'right', label: 'Right — all rows from right' },
  { value: 'outer', label: 'Outer — all rows from both' },
]

export default function JoinPanel({ session, onJoined, onStatus }) {
  const datasets = session?.datasets || []
  const [left, setLeft] = useState('')
  const [right, setRight] = useState('')
  const [how, setHow] = useState('inner')
  const [keys, setKeys] = useState([])
  const [busy, setBusy] = useState(false)

  const leftName = left || datasets[0]?.name
  const rightName = right || datasets[1]?.name

  const commonCols = useMemo(() => {
    const l = datasets.find((d) => d.name === leftName)
    const r = datasets.find((d) => d.name === rightName)
    if (!l || !r || l.name === r.name) return []
    return l.columns.filter((c) => r.columns.includes(c))
  }, [datasets, leftName, rightName])

  if (datasets.length < 2) return null

  const toggleKey = (col) =>
    setKeys((k) => (k.includes(col) ? k.filter((c) => c !== col) : [...k, col]))

  const doJoin = async () => {
    if (leftName === rightName) { onStatus('Pick two different datasets to join.'); return }
    setBusy(true)
    try {
      const res = await joinDatasets(session.session_id, leftName, rightName, how, keys)
      onJoined(res)
      onStatus(`Joined on [${res.join_keys.join(', ')}] → '${res.dataset}' (${res.rows} rows). It is now the active dataset.`)
      setKeys([])
    } catch (err) {
      onStatus(`Join error: ${err.message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="join-panel">
      <h2>Join datasets</h2>
      <label>Left</label>
      <select value={leftName} onChange={(e) => setLeft(e.target.value)}>
        {datasets.map((d) => <option key={d.name} value={d.name}>{d.name} ({d.rows})</option>)}
      </select>
      <label>Right</label>
      <select value={rightName} onChange={(e) => setRight(e.target.value)}>
        {datasets.map((d) => <option key={d.name} value={d.name}>{d.name} ({d.rows})</option>)}
      </select>
      <label>Join type</label>
      <select value={how} onChange={(e) => setHow(e.target.value)}>
        {JOIN_TYPES.map((j) => <option key={j.value} value={j.value}>{j.label}</option>)}
      </select>
      <label>Join key(s) {commonCols.length === 0 && '— no common columns'}</label>
      <div className="key-list">
        {commonCols.map((col) => (
          <label key={col} className="key-item">
            <input
              type="checkbox"
              checked={keys.includes(col)}
              onChange={() => toggleKey(col)}
            />
            {col}
          </label>
        ))}
      </div>
      {commonCols.length > 0 && keys.length === 0 && (
        <p className="join-hint">No keys selected → joins on all common columns.</p>
      )}
      <button disabled={busy || commonCols.length === 0} onClick={doJoin}>
        {busy ? 'Joining…' : 'Join'}
      </button>
    </div>
  )
}
