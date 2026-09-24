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
const INTERACTIVE = new Set(['link', 'button', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemradio', 'menuitemcheckbox', 'option', 'slider', 'treeitem', 'listbox', 'spinbutton', 'textField', 'PopUpButton', 'ToggleButton'])
const MAX_LINES = 400

/** Last snapshot's ref → DOM node, per webContents */
const refs = new WeakMap<WebContents, Map<number, number>>()

async function cdp<T = Record<string, unknown>>(wc: WebContents, method: string, params: object = {}): Promise<T> {
  if (wc.isDestroyed()) throw new Error('The tab has been closed')
  const dbg = wc.debugger
  if (!dbg.isAttached()) {
    dbg.attach('1.3')
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
  /** DOM nodes whose values must never be shown (filled from 1Password) */
  mask?: Set<number>
}

export async function axTree(wc: WebContents, opts: AxOptions = {}): Promise<string> {
  const { nodes } = await cdp<{ nodes: AXNode[] }>(wc, 'Accessibility.getFullAXTree')
  const { boxes, hrefs, vw, vh } = await layoutInfo(wc)
  const byId = new Map(nodes.map((n) => [n.nodeId, n]))
  const map = new Map<number, number>()
  refs.set(wc, map)
  const lines: string[] = []
  const depths: number[] = []
  const base = wc.getURL()
  const filter = opts.filter?.toLowerCase()
  // Searching makes no sense limited to the viewport
  if (filter) opts = { ...opts, all: true }

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
        const masked = !!(n.backendDOMNodeId && opts.mask?.has(n.backendDOMNodeId))
        if (val !== undefined && val !== '' && role !== 'link') line += masked ? ' = "••••••"' : ` = "${String(val).slice(0, 60)}"`
        for (const p of n.properties ?? []) {
          // CDP reports tristate props as strings ("true" / "false" / "mixed")
          const on = p.value.value === true || p.value.value === 'true' || p.value.value === 'mixed'
          if (['checked', 'expanded', 'selected', 'pressed'].includes(p.name) && on) line += ` (${p.name}${p.value.value === 'mixed' ? ': mixed' : ''})`
          if (p.name === 'focused' && on) line += ' (focus)'
          if (p.name === 'disabled' && on) line += ' (disabled)'
        }
        if (role === 'link' && n.backendDOMNodeId && hrefs.has(n.backendDOMNodeId)) line += ` → ${shortHref(hrefs.get(n.backendDOMNodeId)!, base)}`
        if (!filter || line.toLowerCase().includes(filter)) {
          lines.push(line)
          depths.push(depth)
        }
        childDepth = depth + 1
        // Interactive elements are leaves: their inner text is already the name
        if (interactive && name) return
      }
    }
    for (const c of n.childIds ?? []) walk(c, childDepth)
  }

  const root = opts.rootBackendId ? nodes.find((n) => n.backendDOMNodeId === opts.rootBackendId) : nodes[0]
  if (!root) throw new Error('No node found to snapshot')
  walk(root.nodeId, 0)
  let out = lines
  if (filter) {
    // Keep only the deepest match of each branch: row > cell > checkbox all repeat the same text
    out = lines.filter((_, i) => !(i + 1 < lines.length && depths[i + 1] > depths[i])).map((l) => l.trimStart())
  }
  if (lines.length >= MAX_LINES) out.push(`… truncated after ${MAX_LINES} lines (narrow with --filter)`)
  return out.join('\n') || (filter ? `(no elements containing "${opts.filter}")` : '(empty — no elements in view)')
}

export function refNode(wc: WebContents, ref: number): number {
  const backendNodeId = refs.get(wc)?.get(ref)
  if (!backendNodeId) throw new Error(`No ref ${ref} — take a fresh tree first`)
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
/** Apps disagree on how to expose text fields: treat these roles as one family */
const TEXT_FIELDS = new Set(['textbox', 'combobox', 'searchbox', 'textField'])
const roleMatches = (want: string, actual: string): boolean => want === actual || (TEXT_FIELDS.has(want) && TEXT_FIELDS.has(actual))

/** Case/whitespace-insensitive, and "1.5" == "1,5" (locale decimal separators) */
const norm = (v: string): string => v.toLowerCase().replace(/\s+/g, ' ').replace(/(\d),(\d)/g, '$1.$2').trim()

/** All matching nodes, best first; the top score tier only (exact beats prefix beats substring) */
export async function axFindAll(wc: WebContents, q: AxQuery, requireVisible = true): Promise<number[]> {
  const { nodes } = await cdp<{ nodes: AXNode[] }>(wc, 'Accessibility.getFullAXTree')
  const want = norm(q.name)
  const scored: Array<{ id: number; score: number; tier: number }> = []
  for (const n of nodes) {
    if (n.ignored || !n.backendDOMNodeId) continue
    const role = String(n.role?.value ?? '')
    if (q.role && !roleMatches(q.role, role)) continue
    // Without a role, plain text (placeholders, labels) is allowed but ranks below real controls
    if (!q.role && TRANSPARENT.has(role)) continue
    const name = norm(String(n.name?.value ?? ''))
    // Role-only query ("main", "dialog"): any node with that role
    if (!want && q.role) {
      scored.push({ id: n.backendDOMNodeId, score: 1, tier: 1 })
      continue
    }
    if (!name) continue
    const tier = name === want ? 3 : name.startsWith(want) ? 2 : name.includes(want) ? 1 : 0
    if (!tier) continue
    const exactRole = q.role && role === q.role ? 0.25 : 0
    scored.push({ id: n.backendDOMNodeId, tier, score: tier + exactRole + (INTERACTIVE.has(role) ? 0.5 : role === 'StaticText' ? -0.5 : 0) })
  }
  if (!scored.length) return []
  const bestTier = Math.max(...scored.map((c) => c.tier))
  const top = scored.filter((c) => c.tier === bestTier).sort((a, b) => b.score - a.score)
  if (!requireVisible) return top.map((c) => c.id)
  await cdp(wc, 'DOM.enable')
  const visible: number[] = []
  for (const c of top.slice(0, 60)) {
    const { quads } = await cdp<{ quads: number[][] }>(wc, 'DOM.getContentQuads', { backendNodeId: c.id }).catch(() => ({ quads: [] }))
    if (quads.length) visible.push(c.id)
  }
  return visible
}

export async function axFind(wc: WebContents, q: AxQuery, requireVisible = true): Promise<number | null> {
  return (await axFindAll(wc, q, requireVisible))[0] ?? null
}

/** Names of nodes with this role (or all interactive ones) — shown when a lookup fails */
export async function axCandidates(wc: WebContents, role?: string, query = '', limit = 8, onlySimilar = false): Promise<string[]> {
  const { nodes } = await cdp<{ nodes: AXNode[] }>(wc, 'Accessibility.getFullAXTree')
  // Rank by shared word prefixes with the query, so near-misses come first
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2).map((w) => w.slice(0, 4))
  const seen = new Set<string>()
  const scored: Array<{ label: string; score: number }> = []
  for (const n of nodes) {
    if (n.ignored) continue
    const r = String(n.role?.value ?? '')
    if (role ? !roleMatches(role, r) : !INTERACTIVE.has(r)) continue
    const name = String(n.name?.value ?? '').replace(/\s+/g, ' ').trim()
    const label = `${r} "${name.slice(0, 60)}"`
    if (!name || seen.has(label)) continue
    seen.add(label)
    const lower = name.toLowerCase()
    scored.push({ label, score: words.filter((w) => lower.includes(w)).length })
  }
  if (words.length) return scored.filter((c) => c.score).sort((a, b) => b.score - a.score).slice(0, limit).map((c) => c.label)
  return onlySimilar ? [] : scored.slice(0, limit).map((c) => c.label)
}

/** Viewport centre of a DOM node, scrolled into view first */
export { cdp }

export async function nodePoint(wc: WebContents, backendNodeId: number): Promise<{ x: number; y: number; backendNodeId: number }> {
  await cdp(wc, 'DOM.enable')
  await cdp(wc, 'DOM.scrollIntoViewIfNeeded', { backendNodeId }).catch(() => {})
  const { quads } = await cdp<{ quads: number[][] }>(wc, 'DOM.getContentQuads', { backendNodeId })
  if (!quads.length) throw new Error('The element has no visible area')
  const q = quads[0]
  return { x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4, backendNodeId }
}
