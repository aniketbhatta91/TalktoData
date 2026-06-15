import { useEffect, useState } from 'react'
import { listUsers, updateUserStatus } from '../api'

const STATUS_BADGE = {
  pending:  { label: 'Pending',  cls: 'badge-pending' },
  approved: { label: 'Approved', cls: 'badge-approved' },
  rejected: { label: 'Rejected', cls: 'badge-rejected' },
}

const ROLE_ICON = { admin: '👑', user: '👤' }

function fmt(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export default function AdminPanel({ onClose }) {
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('all')   // all | pending | approved | rejected
  const [busy, setBusy] = useState({})          // { [userId]: true } while updating

  useEffect(() => {
    load()
  }, [])

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const res = await listUsers()
      setUsers(res.users)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const changeStatus = async (userId, status) => {
    setBusy(b => ({ ...b, [userId]: true }))
    try {
      const res = await updateUserStatus(userId, status)
      setUsers(prev => prev.map(u => u.id === userId ? res.user : u))
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(b => ({ ...b, [userId]: false }))
    }
  }

  const visible = filter === 'all' ? users : users.filter(u => u.status === filter)
  const counts = {
    all: users.length,
    pending: users.filter(u => u.status === 'pending').length,
    approved: users.filter(u => u.status === 'approved').length,
    rejected: users.filter(u => u.status === 'rejected').length,
  }

  return (
    <>
      <div className="admin-backdrop" onClick={onClose} />
      <div className="admin-panel">
        <div className="admin-head">
          <span>👑 Admin — User Management</span>
          <button className="admin-close" onClick={onClose}>✕</button>
        </div>

        {/* filter tabs */}
        <div className="admin-filters">
          {['all', 'pending', 'approved', 'rejected'].map(f => (
            <button
              key={f}
              className={`admin-filter-btn ${filter === f ? 'active' : ''}`}
              onClick={() => setFilter(f)}
            >
              {f.charAt(0).toUpperCase() + f.slice(1)}
              <span className="admin-filter-count">{counts[f]}</span>
            </button>
          ))}
          <button className="admin-refresh" onClick={load} title="Refresh">↻</button>
        </div>

        {error && <p className="admin-error">⚠️ {error}</p>}

        {loading ? (
          <p className="admin-loading">Loading users…</p>
        ) : visible.length === 0 ? (
          <p className="admin-empty">No users in this category.</p>
        ) : (
          <div className="admin-user-list">
            {visible.map(u => {
              const badge = STATUS_BADGE[u.status] || STATUS_BADGE.pending
              const isBusy = busy[u.id]
              return (
                <div key={u.id} className={`admin-user-row ${u.status}`}>
                  <div className="admin-user-info">
                    <span className="admin-user-icon">{ROLE_ICON[u.role] || '👤'}</span>
                    <div>
                      <span className="admin-user-name">{u.name}</span>
                      <span className="admin-user-email">{u.email}</span>
                      <span className="admin-user-meta">
                        Joined {fmt(u.created_at)}
                        {u.approved_at ? ` · Approved ${fmt(u.approved_at)}` : ''}
                      </span>
                    </div>
                  </div>
                  <div className="admin-user-right">
                    <span className={`admin-badge ${badge.cls}`}>{badge.label}</span>
                    {u.role !== 'admin' && (
                      <div className="admin-actions">
                        {u.status !== 'approved' && (
                          <button
                            className="admin-btn approve"
                            onClick={() => changeStatus(u.id, 'approved')}
                            disabled={isBusy}
                          >
                            ✓ Approve
                          </button>
                        )}
                        {u.status !== 'rejected' && (
                          <button
                            className="admin-btn reject"
                            onClick={() => changeStatus(u.id, 'rejected')}
                            disabled={isBusy}
                          >
                            ✕ Reject
                          </button>
                        )}
                        {u.status !== 'pending' && (
                          <button
                            className="admin-btn reset"
                            onClick={() => changeStatus(u.id, 'pending')}
                            disabled={isBusy}
                          >
                            ↺ Reset
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}

        <p className="admin-note">
          💡 New sign-ups are <strong>pending</strong> until you approve them here.
        </p>
      </div>
    </>
  )
}
