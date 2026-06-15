import { useState } from 'react'
import HeroGraphic from './HeroGraphic'

export default function Welcome({ onSubmit }) {
  const [name, setName] = useState('')

  const enter = () => {
    const clean = name.trim()
    if (clean) onSubmit(clean)
  }

  return (
    <div className="domain-screen welcome-screen">
      <HeroGraphic size={130} />
      <h1 className="domain-title">Talk to Data</h1>
      <p className="domain-sub">Your conversational data analyst</p>
      <div className="welcome-box">
        <label htmlFor="welcome-name">What should we call you?</label>
        <input
          id="welcome-name"
          autoFocus
          value={name}
          maxLength={40}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && enter()}
          placeholder="Enter your name"
        />
        <button disabled={!name.trim()} onClick={enter}>Get started</button>
      </div>
    </div>
  )
}
