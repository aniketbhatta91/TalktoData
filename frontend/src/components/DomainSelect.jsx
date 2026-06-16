import { useState } from 'react'
import HeroGraphic from './HeroGraphic'

export const DOMAINS = [
  {
    id: 'healthcare',
    label: 'Healthcare',
    icon: '🏥',
    desc: 'Patient, clinical & hospital operations data',
    color: '#34d399',
    dataAccept: '.csv,.xlsx,.xls',
    docsAccept: '.pdf,.docx,.xlsx,.xls,.csv,.txt,.md',
  },
  {
    id: 'supplychain',
    label: 'Supply Chain',
    icon: '🚚',
    desc: 'Inventory, logistics, procurement & demand data',
    color: '#60a5fa',
    dataAccept: '.csv,.xlsx,.xls',
    docsAccept: '.pdf,.docx,.xlsx,.xls,.csv,.txt,.md',
  },
  {
    id: 'hr',
    label: 'HR',
    icon: '👥',
    desc: 'Workforce, attrition, hiring & payroll data',
    color: '#f472b6',
    dataAccept: '.xlsx,.xls',
    docsAccept: '.pdf,.docx,.xlsx,.xls,.csv,.txt,.md',
  },
  {
    id: 'retail',
    label: 'Retail',
    icon: '🛍️',
    desc: 'Sales, customers, pricing & store performance data',
    color: '#fb923c',
    dataAccept: '.csv,.xlsx,.xls',
    docsAccept: '.pdf,.docx,.xlsx,.xls,.csv,.txt,.md',
  },
]

// Visual config for each stack depth position (0 = front)
const STACK = [
  { y: 0,  z: 0,    scale: 1,    opacity: 1,    blur: 0,   zIdx: 10 },
  { y: 24, z: -55,  scale: 0.93, opacity: 0.70, blur: 0.8, zIdx: 9  },
  { y: 48, z: -110, scale: 0.86, opacity: 0.45, blur: 1.8, zIdx: 8  },
  { y: 72, z: -165, scale: 0.79, opacity: 0.25, blur: 2.8, zIdx: 7  },
]

function cardStyle(pos, selecting) {
  if (selecting) {
    return pos === 0
      ? { transform: 'translateY(-90px) scale(1.08)', opacity: 0, zIndex: 10, filter: 'none',
          transition: 'all 0.55s cubic-bezier(0.4,0,0.2,1)' }
      : { transform: `translateY(${70 + pos * 18}px) scale(0.72)`, opacity: 0,
          zIndex: STACK[pos].zIdx, filter: 'none',
          transition: `all ${0.42 + pos * 0.07}s cubic-bezier(0.4,0,0.2,1)` }
  }
  const s = STACK[pos]
  return {
    transform: `translateY(${s.y}px) translateZ(${s.z}px) scale(${s.scale})`,
    opacity: s.opacity,
    zIndex: s.zIdx,
    filter: s.blur ? `blur(${s.blur}px)` : 'none',
    transition: 'transform 0.48s cubic-bezier(0.4,0,0.2,1), opacity 0.48s ease, filter 0.48s ease',
  }
}

export default function DomainSelect({ onSelect }) {
  const [activeIdx, setActiveIdx] = useState(0)
  const [selecting, setSelecting] = useState(false)

  const getPos = (i) => (i - activeIdx + DOMAINS.length) % DOMAINS.length

  const cycle = (dir) => {
    if (selecting) return
    setActiveIdx(i => (i + dir + DOMAINS.length) % DOMAINS.length)
  }

  const handleCardClick = (i) => {
    if (selecting) return
    const pos = getPos(i)
    if (pos === 0) {
      setSelecting(true)
      setTimeout(() => onSelect(DOMAINS[i]), 580)
    } else {
      setActiveIdx(i)
    }
  }

  const active = DOMAINS[activeIdx]

  return (
    <div className="domain-screen">
      <HeroGraphic size={90} />
      <h1 className="domain-title">Talk to Data</h1>
      <p className="domain-sub">Choose your domain to get started</p>

      <div className="card-deck">
        {DOMAINS.map((d, i) => {
          const pos = getPos(i)
          const isFront = pos === 0
          return (
            <div
              key={d.id}
              className={`stack-card ${isFront ? 'stack-card--front' : ''}`}
              style={{ ...cardStyle(pos, selecting), '--card-color': d.color }}
              onClick={() => handleCardClick(i)}
              title={isFront ? `Select ${d.label}` : `Switch to ${d.label}`}
            >
              {/* colour glow at top of card */}
              <div className="stack-glow" style={{ background: `radial-gradient(ellipse at 50% 0%, ${d.color}30 0%, transparent 65%)` }} />

              <span className="stack-icon">{d.icon}</span>
              <span className="stack-label">{d.label}</span>
              <span className="stack-desc">{d.desc}</span>

              {isFront && !selecting && (
                <div className="stack-cta">Tap to select ›</div>
              )}
            </div>
          )
        })}
      </div>

      {/* Arrow nav + dots */}
      <div className="deck-nav">
        <button className="deck-arrow" onClick={() => cycle(-1)} disabled={selecting}>‹</button>
        <div className="deck-dots">
          {DOMAINS.map((d, i) => (
            <button
              key={d.id}
              className={`deck-dot ${i === activeIdx ? 'active' : ''}`}
              style={i === activeIdx ? { background: d.color, boxShadow: `0 0 8px ${d.color}` } : {}}
              onClick={() => !selecting && setActiveIdx(i)}
              aria-label={d.label}
            />
          ))}
        </div>
        <button className="deck-arrow" onClick={() => cycle(1)} disabled={selecting}>›</button>
      </div>

      <p className="deck-label">
        {selecting
          ? `✨ Loading ${active.label}…`
          : <><span style={{ color: active.color }}>{active.icon} {active.label}</span> · {active.desc}</>
        }
      </p>
    </div>
  )
}
