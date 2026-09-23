import type { WebContents } from 'electron'

/**
 * Accessibility-tree snapshots over the Chrome DevTools Protocol, similar to
 * Playwright's aria snapshot: roles + names + link targets, compact enough to
 * read, with numeric refs that can be clicked afterwards.
 */

interface AXValue {
  value?: unknown
}
interface AXNode {
  nodeId: string
  ignored: boolean
  role?: AXValue
  name?: AXValue
  value?: AXValue
  properties?: Array<{ name: string; value: AXValue }>
  childIds?: string[]
  backendDOMNodeId?: number
}

/** Roles that only add nesting noise; their children are lifted up */
export const TRANSPARENT = new Set(['generic', 'none', 'presentation', 'InlineTextBox', 'LineBreak', 'group', 'Section', 'paragraph', 'LayoutTable', 'LayoutTableRow', 'LayoutTableCell'])
const INTERACTIVE = new Set(['link', 'button', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'option', 'slider', 'treeitem', 'listbox', 'spinbutton'])
const MAX_LINES = 400

/** Last snapshot's ref → DOM node, per webContents */
const refs = new WeakMap<WebContents, Map<number, number>>()

async function cdp<T = Record<string, unknown>>(wc: WebContents, method: string, params: object = {}): Promise<T> {
  const dbg = wc.debugger
  if (!dbg.isAttached()) {
    dbg.attach('1.3')
    wc.once('destroyed', () => dbg.isAttached() && dbg.detach())
  }
  return (await dbg.sendCommand(method, params)) as T
}

interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** Layout boxes and hrefs of every node, keyed by backend node id (one CDP call) */
async function layoutInfo(wc: WebContents): Promise<{ boxes: Map<number, Box>; hrefs: Map<number, string>; vw: number; vh: number }> {
  const snap = await cdp<{
    documents: Array<{
      nodes: { backendNodeId: number[]; attributes: number[][] }
      layout: { nodeIndex: number[]; bounds: number[][] }
      scrollOffsetX?: number
      scrollOffsetY?: number
    }>
    strings: string[]
  }>(wc, 'DOMSnapshot.captureSnapshot', { computedStyles: [] })
  const doc = snap.documents[0]
  const boxes = new Map<number, Box>()
  const hrefs = new Map<number, string>()
  const sx = doc.scrollOffsetX ?? 0
  const sy = doc.scrollOffsetY ?? 0
  doc.layout.nodeIndex.forEach((ni, i) => {
    const [x, y, w, h] = doc.layout.bounds[i]
    boxes.set(doc.nodes.backendNodeId[ni], { x: x - sx, y: y - sy, w, h })
  })
  doc.nodes.attributes.forEach((attrs, ni) => {
    for (let i = 0; i < attrs.length; i += 2) {
      if (snap.strings[attrs[i]] === 'href') hrefs.set(doc.nodes.backendNodeId[ni], snap.strings[attrs[i + 1]])
    }
  })
  const { result } = await cdp<{ result: { value: [number, number] } }>(wc, 'Runtime.evaluate', {
    expression: '[innerWidth, innerHeight]',
    returnByValue: true
  })
  return { boxes, hrefs, vw: result.value[0], vh: result.value[1] }
}

function shortHref(href: string, base: string): string {
  try {
    const u = new URL(href, base)
    const b = new URL(base)
    return u.host === b.host ? u.pathname + u.search : u.host + u.pathname
  } catch {
    return href
  }
}

export interface AxOptions {
  /** Include nodes outside the viewport */
  all?: boolean
  /** Only lines containing this text (case-insensitive), plus their refs */
  filter?: string
  /** Start the walk at this DOM node (snapshot of one region/dialog) */
  rootBackendId?: number
}

export async function axTree(wc: WebContents, opts: AxOptions = {}): Promise<string> {
  const { nodes } = await cdp<{ nodes: AXNode[] }>(wc, 'Accessibility.getFullAXTree')
  const { boxes, hrefs, vw, vh } = await layoutInfo(wc)
  const byId = new Map(nodes.map((n) => [n.nodeId, n]))
  const map = new Map<number, number>()
  refs.set(wc, map)
  const lines: string[] = []
  const base = wc.getURL()
  const filter = opts.filter?.toLowerCase()

  const visible = (n: AXNode): boolean => {
    if (opts.all || !n.backendDOMNodeId) return true
    const b = boxes.get(n.backendDOMNodeId)
    if (!b) return true // no own box (e.g. inline); keep and let children decide
    return b.w > 0 && b.h > 0 && b.x < vw && b.y < vh && b.x + b.w > 0 && b.y + b.h > 0
  }

  const walk = (id: string, depth: number): void => {
    if (lines.length >= MAX_LINES) return
    const n = byId.get(id)
    if (!n) return
    const role = String(n.role?.value ?? '')
    const name = String(n.name?.value ?? '').replace(/\s+/g, ' ').trim()
    const transparent = n.ignored || TRANSPARENT.has(role) || role === 'RootWebArea' || (role === 'StaticText' && !name)
    let childDepth = depth

    if (!transparent && visible(n)) {
      const interactive = INTERACTIVE.has(role)
      // Plain text next to its interactive parent is just the parent's name again
      const redundant = role === 'StaticText' && lines.length && lines[lines.length - 1].includes(`"${name.slice(0, 60)}`)
      if (!redundant && (interactive || name || role === 'heading' || role === 'img' || role === 'list' || role === 'navigation' || role === 'main' || role === 'dialog')) {
        let line = `${'  '.repeat(depth)}`
        if (interactive && n.backendDOMNodeId) {
          const ref = map.size + 1
          map.set(ref, n.backendDOMNodeId)
          line += `[${ref}] `
        }
        line += role === 'StaticText' ? `"${name.slice(0, 120)}"` : `${role}${name ? ` "${name.slice(0, 100)}"` : ''}`
        const val = n.value?.value
        if (val !== undefined && val !== '' && role !== 'link') line += ` = "${String(val).slice(0, 60)}"`
        for (const p of n.properties ?? []) {
          if (['checked', 'expanded', 'selected', 'pressed'].includes(p.name) && p.value.value) line += ` (${p.name})`
          if (p.name === 'focused' && p.value.value) line += ' (focus)'
          if (p.name === 'disabled' && p.value.value) line += ' (disabled)'
        }
        if (role === 'link' && n.backendDOMNodeId && hrefs.has(n.backendDOMNodeId)) line += ` → ${shortHref(hrefs.get(n.backendDOMNodeId)!, base)}`
        if (!filter || line.toLowerCase().includes(filter)) lines.push(line)
        childDepth = depth + 1
        // Interactive elements are leaves: their inner text is already the name
        if (interactive && name) return
      }
    }
    for (const c of n.childIds ?? []) walk(c, childDepth)
  }

  const root = opts.rootBackendId ? nodes.find((n) => n.backendDOMNodeId === opts.rootBackendId) : nodes[0]
  if (!root) throw new Error('Nie znaleziono węzła do snapshotu')
  walk(root.nodeId, 0)
  if (lines.length >= MAX_LINES) lines.push(`… ucięto po ${MAX_LINES} liniach (użyj --filter)`)
  return lines.join('\n') || '(pusto — brak elementów w widoku)'
}

export function refNode(wc: WebContents, ref: number): number {
  const backendNodeId = refs.get(wc)?.get(ref)
  if (!backendNodeId) throw new Error(`Brak ref ${ref} — zrób najpierw świeży tree`)
  return backendNodeId
}

/** Known ARIA roles; a selector starting with one of these is "role name" */
export const ROLES = new Set([
  ...INTERACTIVE,
  'heading', 'img', 'dialog', 'region', 'navigation', 'main', 'row', 'gridcell', 'cell', 'list', 'listitem', 'alert', 'status', 'article', 'form', 'toolbar', 'menu', 'tabpanel'
])

export interface AxQuery {
  role?: string
  name: string
}

/**
 * Finds the best visible node for role + accessible name: exact name first,
 * then prefix, then substring. Hidden duplicates (common in Gmail) are skipped.
 */
export async function axFind(wc: WebContents, q: AxQuery, requireVisible = true): Promise<number | null> {
  const { nodes } = await cdp<{ nodes: AXNode[] }>(wc, 'Accessibility.getFullAXTree')
  const want = q.name.toLowerCase().replace(/\s+/g, ' ').trim()
  const scored: Array<{ id: number; score: number }> = []
  for (const n of nodes) {
    if (n.ignored || !n.backendDOMNodeId) continue
    const role = String(n.role?.value ?? '')
    if (q.role && role !== q.role) continue
    if (!q.role && (TRANSPARENT.has(role) || role === 'StaticText')) continue
    const name = String(n.name?.value ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
    if (!name) continue
    const score = name === want ? 3 : name.startsWith(want) ? 2 : name.includes(want) ? 1 : 0
    if (score) scored.push({ id: n.backendDOMNodeId, score: score + (INTERACTIVE.has(role) ? 0.5 : 0) })
  }
  scored.sort((a, b) => b.score - a.score)
  if (!requireVisible) return scored[0]?.id ?? null
  await cdp(wc, 'DOM.enable')
  for (const c of scored.slice(0, 15)) {
    const { quads } = await cdp<{ quads: number[][] }>(wc, 'DOM.getContentQuads', { backendNodeId: c.id }).catch(() => ({ quads: [] }))
    if (quads.length) return c.id
  }
  return null
}

/** Names of nodes with this role (or all interactive ones) — shown when a lookup fails */
export async function axCandidates(wc: WebContents, role?: string, query = '', limit = 8): Promise<string[]> {
  const { nodes } = await cdp<{ nodes: AXNode[] }>(wc, 'Accessibility.getFullAXTree')
  // Rank by shared word prefixes with the query, so near-misses come first
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2).map((w) => w.slice(0, 4))
  const seen = new Set<string>()
  const scored: Array<{ label: string; score: number }> = []
  for (const n of nodes) {
    if (n.ignored) continue
    const r = String(n.role?.value ?? '')
    if (role ? r !== role : !INTERACTIVE.has(r)) continue
    const name = String(n.name?.value ?? '').replace(/\s+/g, ' ').trim()
    const label = `${r} "${name.slice(0, 60)}"`
    if (!name || seen.has(label)) continue
    seen.add(label)
    const lower = name.toLowerCase()
    scored.push({ label, score: words.filter((w) => lower.includes(w)).length })
  }
  if (words.length && scored.some((c) => c.score)) return scored.filter((c) => c.score).sort((a, b) => b.score - a.score).slice(0, limit).map((c) => c.label)
  return scored.slice(0, limit).map((c) => c.label)
}

/** Viewport centre of a DOM node, scrolled into view first */
export async function nodePoint(wc: WebContents, backendNodeId: number): Promise<{ x: number; y: number; backendNodeId: number }> {
  await cdp(wc, 'DOM.enable')
  await cdp(wc, 'DOM.scrollIntoViewIfNeeded', { backendNodeId }).catch(() => {})
  const { quads } = await cdp<{ quads: number[][] }>(wc, 'DOM.getContentQuads', { backendNodeId })
  if (!quads.length) throw new Error('Element nie ma widocznego obszaru')
  const q = quads[0]
  return { x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4, backendNodeId }
}
