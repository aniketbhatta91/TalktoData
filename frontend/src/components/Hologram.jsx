// Rotating 3D hologram loader (pure CSS 3D, no libraries)
export default function Hologram() {
  return (
    <div className="holo-wrap">
      <div className="holo">
        <div className="holo-core" />
        <div className="holo-ring r1" />
        <div className="holo-ring r2" />
        <div className="holo-ring r3" />
        <div className="holo-particles">
          {[...Array(8)].map((_, i) => (
            <span key={i} className="holo-dot" style={{ '--i': i }} />
          ))}
        </div>
      </div>
      <div className="holo-base" />
      <p className="holo-label">Analyzing…</p>
    </div>
  )
}
