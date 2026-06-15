import { useEffect, useRef } from 'react'
import Plotly from 'plotly.js-dist-min'

export default function PlotlyChart({ figure }) {
  const ref = useRef(null)

  useEffect(() => {
    if (!ref.current || !figure) return
    Plotly.newPlot(ref.current, figure.data, { ...figure.layout, autosize: true }, { responsive: true })
    return () => Plotly.purge(ref.current)
  }, [figure])

  return <div ref={ref} className="chart" />
}
