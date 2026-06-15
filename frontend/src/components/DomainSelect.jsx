import HeroGraphic from './HeroGraphic'

export const DOMAINS = [
  {
    id: 'healthcare',
    label: 'Healthcare',
    icon: '🏥',
    desc: 'Patient, clinical & hospital operations data',
    dataAccept: '.csv,.xlsx,.xls',
    docsAccept: '.pdf,.docx,.xlsx,.xls,.csv,.txt,.md',
  },
  {
    id: 'supplychain',
    label: 'Supply Chain',
    icon: '🚚',
    desc: 'Inventory, logistics, procurement & demand data',
    dataAccept: '.csv,.xlsx,.xls',
    docsAccept: '.pdf,.docx,.xlsx,.xls,.csv,.txt,.md',
  },
  {
    id: 'hr',
    label: 'HR',
    icon: '👥',
    desc: 'Workforce, attrition, hiring & payroll data',
    dataAccept: '.xlsx,.xls',
    docsAccept: '.pdf,.docx,.xlsx,.xls,.csv,.txt,.md',
  },
  {
    id: 'retail',
    label: 'Retail',
    icon: '🛍️',
    desc: 'Sales, customers, pricing & store performance data',
    dataAccept: '.csv,.xlsx,.xls',
    docsAccept: '.pdf,.docx,.xlsx,.xls,.csv,.txt,.md',
  },
]

export default function DomainSelect({ onSelect }) {
  return (
    <div className="domain-screen">
      <HeroGraphic size={110} />
      <h1 className="domain-title">Talk to Data</h1>
      <p className="domain-sub">Choose your domain to get started</p>
      <div className="domain-grid">
        {DOMAINS.map((d, i) => (
          <button key={d.id} className="domain-card" style={{ '--i': i }} onClick={() => onSelect(d)}>
            <span className="domain-icon">{d.icon}</span>
            <span className="domain-label">{d.label}</span>
            <span className="domain-desc">{d.desc}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
