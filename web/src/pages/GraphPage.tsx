import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, type SimulationLinkDatum, type SimulationNodeDatum } from 'd3-force'
import { api, enc, qs } from '../lib/api'
import { useTypes } from '../lib/state'
import { Spinner, typeColor } from '../lib/ui'
import { embedNavigate } from './NotePage'
import { tr } from '../lib/i18n'

interface GNode extends SimulationNodeDatum {
  id: string
  title: string
  type: string
  degree: number
}

export function GraphPage({ embedded }: { embedded?: boolean } = {}) {
  const { vault = '' } = useParams()
  const params = new URLSearchParams(location.search)
  const navigate = useNavigate()
  const types = useTypes(vault)
  const [campaign, setCampaign] = useState(params.get('campaign') ?? '')
  const [hidden, setHidden] = useState<Set<string>>(new Set(['fact']))
  const [campaigns, setCampaigns] = useState<string[]>([])
  const [data, setData] = useState<{ nodes: GNode[]; edges: { source: string; target: string }[] } | null>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const wrap = useRef<HTMLDivElement>(null)

  useEffect(() => {
    api<{ items: { title: string }[] }>(`/vaults/${enc(vault)}/campaigns`)
      .then((r) => setCampaigns(r.items.map((c) => c.title)))
      .catch(() => undefined)
  }, [vault])

  useEffect(() => {
    setData(null)
    api<any>(`/vaults/${enc(vault)}/graph${qs({ campaign, visibility: params.get('visibility') ?? undefined })}`)
      .then(setData)
      .catch(() => setData({ nodes: [], edges: [] }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vault, campaign])

  useEffect(() => {
    if (!data || !canvas.current || !wrap.current) return
    const c = canvas.current
    const ctx = c.getContext('2d')!
    const dpr = window.devicePixelRatio || 1
    let w = wrap.current.clientWidth
    let h = wrap.current.clientHeight
    const resize = () => {
      w = wrap.current!.clientWidth
      h = wrap.current!.clientHeight
      c.width = w * dpr
      c.height = h * dpr
      fit()
      draw()
    }
    const nodes: GNode[] = data.nodes.filter((n) => !hidden.has(n.type)).map((n) => ({ ...n }))
    const ids = new Set(nodes.map((n) => n.id))
    const links: SimulationLinkDatum<GNode>[] = data.edges.filter((e) => ids.has(e.source) && ids.has(e.target)).map((e) => ({ source: e.source, target: e.target }))
    let transform = { x: 0, y: 0, k: 1 }
    let hover: GNode | null = null
    const styles = getComputedStyle(document.documentElement)
    const text = styles.getPropertyValue('--text').trim() || '#222'
    const border = styles.getPropertyValue('--border-strong').trim() || '#ccc'
    const accent = styles.getPropertyValue('--accent').trim() || '#e57d43'

    const radius = (n: GNode) => 4 + Math.sqrt(n.degree) * 2.2
    // Wenige Notizen: mehr Abstand, damit sich die Beschriftungen nicht überlappen
    const spread = Math.max(1, Math.min(2.5, 40 / Math.max(nodes.length, 1)))
    ctx.font = '11px system-ui, sans-serif'
    const labelHalf = new Map(nodes.map((n) => [n.id, Math.min(70, ctx.measureText(n.title).width / 2)]))
    // Bis zur ersten eigenen Bewegung passt sich der Ausschnitt dem Graphen an
    let autoFit = true
    const fit = () => {
      if (!autoFit || !nodes.length) return
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
      for (const n of nodes) {
        const lw = labelHalf.get(n.id) ?? 0
        x0 = Math.min(x0, n.x! - lw)
        x1 = Math.max(x1, n.x! + lw)
        y0 = Math.min(y0, n.y! - radius(n))
        y1 = Math.max(y1, n.y! + radius(n) + 16)
      }
      const pad = 40
      const k = Math.min(1.6, Math.max(0.3, Math.min((w - pad * 2) / Math.max(x1 - x0, 1), (h - pad * 2) / Math.max(y1 - y0, 1))))
      transform = { k, x: -((x0 + x1) / 2) * k, y: -((y0 + y1) / 2) * k }
    }

    const sim = forceSimulation(nodes)
      .force('link', forceLink<GNode, SimulationLinkDatum<GNode>>(links).id((d) => d.id).distance(60 * spread).strength(0.4))
      .force('charge', forceManyBody().strength(-160 * spread))
      .force('center', forceCenter(0, 0))
      .force('collide', forceCollide<GNode>().radius((d) => Math.max(radius(d) + 8, (labelHalf.get(d.id) ?? 0) * 0.8)))
      .on('tick', () => {
        fit()
        draw()
      })
    function draw() {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      ctx.translate(w / 2 + transform.x, h / 2 + transform.y)
      ctx.scale(transform.k, transform.k)
      const neighbors = new Set<string>()
      if (hover) {
        for (const l of links) {
          const s = l.source as GNode
          const t = l.target as GNode
          if (s.id === hover.id) neighbors.add(t.id)
          if (t.id === hover.id) neighbors.add(s.id)
        }
      }
      ctx.lineWidth = 1 / transform.k
      for (const l of links) {
        const s = l.source as GNode
        const t = l.target as GNode
        const hl = hover && (s.id === hover.id || t.id === hover.id)
        ctx.strokeStyle = hl ? accent : border
        ctx.globalAlpha = hover && !hl ? 0.25 : 0.8
        ctx.beginPath()
        ctx.moveTo(s.x!, s.y!)
        ctx.lineTo(t.x!, t.y!)
        ctx.stroke()
      }
      for (const n of nodes) {
        const dim = hover && n.id !== hover.id && !neighbors.has(n.id)
        ctx.globalAlpha = dim ? 0.3 : 1
        ctx.fillStyle = typeColor(n.type)
        ctx.beginPath()
        ctx.arc(n.x!, n.y!, radius(n), 0, Math.PI * 2)
        ctx.fill()
        if (transform.k > 0.7 || n === hover || neighbors.has(n.id) || n.degree > 4) {
          ctx.fillStyle = text
          ctx.font = `${(n === hover ? 13 : 11) / Math.max(transform.k, 0.6)}px system-ui, sans-serif`
          ctx.textAlign = 'center'
          ctx.fillText(n.title, n.x!, n.y! + radius(n) + 12 / transform.k)
        }
      }
      ctx.globalAlpha = 1
    }

    const toWorld = (ev: { clientX: number; clientY: number }) => {
      const r = c.getBoundingClientRect()
      return { x: (ev.clientX - r.left - w / 2 - transform.x) / transform.k, y: (ev.clientY - r.top - h / 2 - transform.y) / transform.k }
    }
    const pick = (ev: { clientX: number; clientY: number }) => {
      const p = toWorld(ev)
      let best: GNode | null = null
      let bd = Infinity
      for (const n of nodes) {
        const d = (n.x! - p.x) ** 2 + (n.y! - p.y) ** 2
        if (d < bd && d < (radius(n) + 5) ** 2) {
          bd = d
          best = n
        }
      }
      return best
    }
    let drag: { node: GNode | null; sx: number; sy: number; ox: number; oy: number; moved: boolean } | null = null
    const down = (ev: PointerEvent) => {
      const n = pick(ev)
      if (!n) autoFit = false
      drag = { node: n, sx: ev.clientX, sy: ev.clientY, ox: transform.x, oy: transform.y, moved: false }
      c.setPointerCapture(ev.pointerId)
      if (n) sim.alphaTarget(0.3).restart()
    }
    const move = (ev: PointerEvent) => {
      if (drag) {
        if (Math.abs(ev.clientX - drag.sx) + Math.abs(ev.clientY - drag.sy) > 3) drag.moved = true
        if (drag.node) {
          const p = toWorld(ev)
          drag.node.fx = p.x
          drag.node.fy = p.y
        } else {
          transform = { ...transform, x: drag.ox + ev.clientX - drag.sx, y: drag.oy + ev.clientY - drag.sy }
          draw()
        }
        return
      }
      const n = pick(ev)
      if (n !== hover) {
        hover = n
        c.style.cursor = n ? 'pointer' : 'grab'
        draw()
      }
    }
    const up = () => {
      if (drag?.node) {
        const n = drag.node
        n.fx = null
        n.fy = null
        sim.alphaTarget(0)
        if (!drag.moved) {
          if (!embedNavigate(n.id, n.title, n.type)) navigate(embedded ? `/embed/${vault}/note/${enc(n.id)}${location.search}` : `/${vault}/note/${enc(n.id)}`)
        }
      }
      drag = null
    }
    const wheel = (ev: WheelEvent) => {
      ev.preventDefault()
      autoFit = false
      const k = Math.min(4, Math.max(0.2, transform.k * (ev.deltaY < 0 ? 1.1 : 0.9)))
      transform = { ...transform, k }
      draw()
    }
    c.addEventListener('pointerdown', down)
    c.addEventListener('pointermove', move)
    c.addEventListener('pointerup', up)
    c.addEventListener('wheel', wheel, { passive: false })
    const ro = new ResizeObserver(resize)
    ro.observe(wrap.current)
    resize()
    return () => {
      sim.stop()
      ro.disconnect()
      c.removeEventListener('pointerdown', down)
      c.removeEventListener('pointermove', move)
      c.removeEventListener('pointerup', up)
      c.removeEventListener('wheel', wheel)
    }
  }, [data, hidden, navigate, vault, embedded])

  const present = [...new Set((data?.nodes ?? []).map((n) => n.type))]

  return (
    <div className="page" style={{ display: 'flex', flexDirection: 'column', height: embedded ? '100vh' : '100%', maxWidth: 'none' }}>
      <div className="page-header">
        {!embedded && <h1>{tr('Graph')}</h1>}
        {campaigns.length > 0 && (
          <select className="input" style={{ width: 'auto' }} value={campaign} onChange={(e) => setCampaign(e.target.value)} aria-label={tr('Kampagne')}>
            <option value="">{tr('Alle Kampagnen')}</option>
            {campaigns.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        )}
        <span className="small muted">{data ? tr('{length} Notizen · {length2} Verbindungen', { length: data.nodes.length, length2: data.edges.length }) : ''}</span>
      </div>
      <div className="graph-wrap" ref={wrap}>
        {!data && (
          <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
            <Spinner />
          </div>
        )}
        <canvas ref={canvas} aria-label={tr('Graph der Notizen')} role="img" />
        <div className="graph-legend">
          {present.map((t) => (
            <button
              key={t}
              className="chip"
              style={{ cursor: 'pointer', opacity: hidden.has(t) ? 0.45 : 1 }}
              onClick={() =>
                setHidden((s) => {
                  const n = new Set(s)
                  if (n.has(t)) n.delete(t)
                  else n.add(t)
                  return n
                })
              }
              aria-pressed={!hidden.has(t)}
            >
              <span className="type-dot" style={{ background: typeColor(t) }} /> {types.find((x) => x.name === t)?.label ?? t}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
