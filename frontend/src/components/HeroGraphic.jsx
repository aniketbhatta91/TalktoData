// AI "neural network" hero graphic (pure SVG, no external assets)
export default function HeroGraphic({ size = 150 }) {
  const nodes = [
    [30, 40], [30, 90], [30, 140],          // input layer
    [95, 25], [95, 70], [95, 115], [95, 160], // hidden layer
    [160, 55], [160, 125],                   // output layer
  ]
  const edges = []
  for (let i = 0; i < 3; i++) for (let j = 3; j < 7; j++) edges.push([i, j])
  for (let j = 3; j < 7; j++) for (let k = 7; k < 9; k++) edges.push([j, k])

  return (
    <svg width={size} height={size} viewBox="0 0 190 185" fill="none">
      <defs>
        <linearGradient id="edgeGrad" x1="0" y1="0" x2="190" y2="185" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#818cf8" />
          <stop offset="100%" stopColor="#22d3ee" />
        </linearGradient>
        <radialGradient id="nodeGrad" cx="35%" cy="35%" r="80%">
          <stop offset="0%" stopColor="#c4b5fd" />
          <stop offset="100%" stopColor="#6366f1" />
        </radialGradient>
      </defs>
      {edges.map(([a, b], i) => (
        <line
          key={i}
          x1={nodes[a][0]} y1={nodes[a][1]} x2={nodes[b][0]} y2={nodes[b][1]}
          stroke="url(#edgeGrad)" strokeWidth="1.1" opacity="0.45"
        />
      ))}
      {nodes.map(([x, y], i) => (
        <g key={i}>
          <circle cx={x} cy={y} r="11" fill="url(#nodeGrad)" opacity="0.25">
            <animate attributeName="r" values="11;14;11" dur={`${2 + (i % 3)}s`} repeatCount="indefinite" />
          </circle>
          <circle cx={x} cy={y} r="6.5" fill="url(#nodeGrad)" />
        </g>
      ))}
    </svg>
  )
}
