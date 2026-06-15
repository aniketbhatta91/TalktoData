import { useState } from 'react'
import { signIn, signUp } from '../api'
import HeroGraphic from './HeroGraphic'

export default function AuthPage({ onAuth }) {
  const [tab, setTab] = useState('signin')
  const [form, setForm] = useState({ name: '', email: '', password: '', confirm: '' })
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [loading, setLoading] = useState(false)

  const set = (field) => (e) => {
    setForm(f => ({ ...f, [field]: e.target.value }))
    setError('')
  }

  const switchTab = (t) => {
    setTab(t)
    setError('')
    setSuccess('')
  }

  const handleSignIn = async (e) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const res = await signIn(form.email.trim(), form.password)
      localStorage.setItem('talk_to_data_token', res.token)
      localStorage.setItem('talk_to_data_user', JSON.stringify(res.user))
      onAuth(res.user)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const handleSignUp = async (e) => {
    e.preventDefault()
    setError('')
    if (form.password !== form.confirm) { setError('Passwords do not match'); return }
    if (form.password.length < 6) { setError('Password must be at least 6 characters'); return }
    setLoading(true)
    try {
      await signUp(form.name.trim(), form.email.trim(), form.password)
      setSuccess('Account created! Awaiting admin approval before you can sign in.')
      setForm(f => ({ ...f, password: '', confirm: '', name: '' }))
      setTab('signin')
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-hero">
          <HeroGraphic size={72} />
          <h1 className="auth-title">Talk to Data</h1>
          <p className="auth-sub">AI-powered conversational data analysis</p>
        </div>

        <div className="auth-tabs">
          <button
            className={`auth-tab ${tab === 'signin' ? 'active' : ''}`}
            onClick={() => switchTab('signin')}
          >
            Sign In
          </button>
          <button
            className={`auth-tab ${tab === 'signup' ? 'active' : ''}`}
            onClick={() => switchTab('signup')}
          >
            Sign Up
          </button>
        </div>

        {success && <p className="auth-success">✅ {success}</p>}
        {error && <p className="auth-error">⚠️ {error}</p>}

        {tab === 'signin' ? (
          <form className="auth-form" onSubmit={handleSignIn}>
            <label className="auth-label">Email</label>
            <input
              type="email"
              className="auth-input"
              placeholder="you@example.com"
              value={form.email}
              onChange={set('email')}
              required
              autoFocus
            />
            <label className="auth-label">Password</label>
            <input
              type="password"
              className="auth-input"
              placeholder="••••••••"
              value={form.password}
              onChange={set('password')}
              required
            />
            <button className="auth-btn" type="submit" disabled={loading}>
              {loading ? 'Signing in…' : 'Sign In'}
            </button>
            <p className="auth-hint">
              Don't have an account?{' '}
              <button type="button" className="auth-link" onClick={() => switchTab('signup')}>
                Sign Up
              </button>
            </p>
          </form>
        ) : (
          <form className="auth-form" onSubmit={handleSignUp}>
            <label className="auth-label">Full Name</label>
            <input
              className="auth-input"
              placeholder="Your name"
              value={form.name}
              onChange={set('name')}
              required
              autoFocus
            />
            <label className="auth-label">Email</label>
            <input
              type="email"
              className="auth-input"
              placeholder="you@example.com"
              value={form.email}
              onChange={set('email')}
              required
            />
            <label className="auth-label">Password</label>
            <input
              type="password"
              className="auth-input"
              placeholder="Min. 6 characters"
              value={form.password}
              onChange={set('password')}
              required
            />
            <label className="auth-label">Confirm Password</label>
            <input
              type="password"
              className="auth-input"
              placeholder="Repeat password"
              value={form.confirm}
              onChange={set('confirm')}
              required
            />
            <button className="auth-btn" type="submit" disabled={loading}>
              {loading ? 'Creating account…' : 'Sign Up'}
            </button>
            <p className="auth-hint">
              After signing up, an admin must approve your account before you can sign in.
            </p>
            <p className="auth-hint">
              Already have an account?{' '}
              <button type="button" className="auth-link" onClick={() => switchTab('signin')}>
                Sign In
              </button>
            </p>
          </form>
        )}
      </div>
    </div>
  )
}
