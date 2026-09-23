import { app, Menu, type MenuItem, type WebContents } from 'electron'
import { randomBytes, randomUUID } from 'crypto'
import { writeFileSync } from 'fs'
import { createServer } from 'http'
import type { AddressInfo } from 'net'
import { join } from 'path'
import { axCandidates, axFind, axFindAll, axTree, cdp, nodePoint, refNode, ROLES } from './ax'

/**
 * Local automation channel: lets a coding agent (or scripts/drift-ctl) read
 * state, inspect views as text and click/type without screenshots.
 * Bound to 127.0.0.1 and guarded by a random token stored with 0600 perms.
 *
 * Every response carries meta (instance id + change counter) so callers notice
 * restarts, and every input action reports what it changed, what it actually
 * hit and which errors appeared since the previous command.
 */

export type Target = 'sidebar' | 'page' | 'find'

/** Flat, privacy-safe status: for pages only url/title/loading */
export type Status = Record<string, string | number | boolean | null>

export interface ControlContext {
  target: (name: Target) => WebContents | null
  actions: Record<string, (...args: unknown[]) => unknown>
  summary: () => unknown
  status: () => Status
  seq: () => number
  /** Slides the compact sidebar in so its elements can be clicked */
  revealSidebar: () => Promise<void>
}

const INSTANCE = randomUUID().slice(0, 8)
const LOG_LIMIT = 500

interface LogEntry {
  i: number
  level: 'info' | 'warning' | 'error'
  line: string
}
const logs: LogEntry[] = []
let logCounter = 0
/** Index of the newest log entry already reported to the caller */
let reported = 0

function pushLog(level: LogEntry['level'], line: string): void {
  logs.push({ i: ++logCounter, level, line: `${new Date().toISOString().slice(11, 19)} ${line}` })
  if (logs.length > LOG_LIMIT) logs.splice(0, logs.length - LOG_LIMIT)
}

const LEVEL: Record<string, LogEntry['level']> = { error: 'error', warning: 'warning' }

/** Full console capture for Drift's own views */
export function captureConsole(wc: WebContents, label: string): void {
  wc.on('console-message', (e) => pushLog(LEVEL[e.level] ?? 'info', `[${label}] ${e.level}: ${e.message}`))
  wc.on('render-process-gone', (_e, d) => pushLog('error', `[${label}] crashed: ${d.reason}`))
}

/** Pages: only errors and failed loads, truncated — no regular console output */
/** Third-party ad/tracking noise that says nothing about whether a task worked */
const NOISE = /doubleclick|googleads|googlesyndication|google-analytics|googletagmanager|adservice|ERR_BLOCKED_BY_CLIENT|net::ERR_ABORTED/i

export function capturePageErrors(wc: WebContents): void {
  wc.on('console-message', (e) => {
    if (e.level !== 'error' || NOISE.test(e.message)) return
    const line = `[page ${hostOf(wc.getURL())}] ${e.message.replace(/\s+/g, ' ').slice(0, 160)}`
    // Same error in a loop (retries, polling) is reported once
    if (logs.slice(-20).some((l) => l.line.endsWith(line))) return
    pushLog('error', line)
  })
  wc.on('did-fail-load', (_e, code, desc, url, isMain) => {
    // -3 = aborted (redirects, user navigating away)
    if (code !== -3 && isMain) pushLog('error', `[page] nie załadowano ${hostOf(url)}: ${desc} (${code})`)
  })
  wc.on('render-process-gone', (_e, d) => pushLog('error', `[page ${hostOf(wc.getURL())}] crashed: ${d.reason}`))
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url.slice(0, 40)
  }
}

function newErrors(): string[] {
  const out = logs.filter((l) => l.i > reported && l.level === 'error').map((l) => l.line)
  reported = logCounter
  return out.slice(-10)
}

// ---------- element location ----------

const locateJs = (sel: { selector?: string; text?: string }): string => `(() => {
  const sel = ${JSON.stringify(sel)};
  let el = null;
  if (sel.selector) el = document.querySelector(sel.selector);
  else if (sel.text) {
    const want = sel.text.toLowerCase();
    const all = [...document.querySelectorAll('a,button,input,textarea,[role],[draggable="true"],[tabindex],span,div,h1,h2,h3')];
    const txt = (e) => (e.innerText || e.value || e.title || e.getAttribute('aria-label') || '').trim().toLowerCase();
    el = all.find((e) => txt(e) === want) || all.find((e) => txt(e).includes(want));
  }
  if (!el) return null;
  el.scrollIntoView({ block: 'nearest' });
  document.querySelectorAll('[data-drift-target]').forEach((e) => e.removeAttribute('data-drift-target'));
  el.setAttribute('data-drift-target', '1');
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
})()`

const DESCRIBE_FN = `function describe(e) {
  if (!e) return 'nic';
  const label = (e.getAttribute('aria-label') || e.title || e.innerText || e.value || '').replace(/\\s+/g, ' ').trim().slice(0, 50);
  const cls = typeof e.className === 'string' ? e.className.split(' ').filter((c) => c && !c.startsWith('svelte-') && !c.startsWith('s-')).slice(0, 2).join('.') : '';
  return e.tagName.toLowerCase() + (cls ? '.' + cls : '') + (label ? ' "' + label + '"' : '');
}`

/** What sits under (x, y), and whether it is (inside) the intended element */
const hitJs = (x: number, y: number): string => `(() => {
  ${DESCRIBE_FN}
  const hit = document.elementFromPoint(${x}, ${y});
  const target = document.querySelector('[data-drift-target]');
  const ok = !target || !!(hit && (hit === target || target.contains(hit)));
  return { ok, hit: describe(hit), target: target ? describe(target) : null };
})()`

async function hitForRef(wc: WebContents, backendNodeId: number, x: number, y: number): Promise<{ ok: boolean; hit: string; target: string }> {
  const dbg = wc.debugger
  const { object: target } = (await dbg.sendCommand('DOM.resolveNode', { backendNodeId })) as { object: { objectId: string } }
  const { result } = (await dbg.sendCommand('Runtime.callFunctionOn', {
    objectId: target.objectId,
    functionDeclaration: `function (x, y) {
      ${DESCRIBE_FN}
      const hit = document.elementFromPoint(x, y);
      const ok = !!(hit && (hit === this || this.contains(hit)));
      return { ok, hit: describe(hit), target: describe(this) };
    }`,
    arguments: [{ value: x }, { value: y }],
    returnByValue: true
  })) as { result: { value: { ok: boolean; hit: string; target: string } } }
  return result.value
}

// ---------- unified selectors ----------

/**
 * One selector syntax for every command:
 *   12                 → ref from the latest tree
 *   css:.tile          → CSS selector
 *   text:Clear         → element by visible text (DOM)
 *   button Wyślij      → role + accessible name (role must be a known ARIA role)
 *   Wyślij             → accessible name, any role
 */
/** Fuzzy matches used during the current command, reported back to the caller */
let fuzzyNotes: string[] = []

type Resolved = { kind: 'node'; backendNodeId: number } | { kind: 'dom'; x: number; y: number }

function parseSelector(raw: string): { ref?: number; css?: string; text?: string; role?: string; name?: string; fuzzy?: boolean } {
  let sel = raw.trim()
  // "~name" / "role ~name": accept the single most similar element if nothing matches exactly
  let fuzzy = false
  const fz = sel.match(/^(?:(\w+)\s+)?~(.+)$/)
  if (fz) {
    fuzzy = true
    sel = fz[1] ? `${fz[1]} ${fz[2]}` : fz[2]
  }
  const parsed = parseSelectorPlain(sel)
  return { ...parsed, fuzzy }
}

function parseSelectorPlain(sel: string): { ref?: number; css?: string; text?: string; role?: string; name?: string } {
  if (/^\d+$/.test(sel)) return { ref: Number(sel) }
  if (sel.startsWith('css:')) return { css: sel.slice(4).trim() }
  if (sel.startsWith('text:')) return { text: sel.slice(5).trim() }
  const unquote = (v: string): string => v.trim().replace(/^["'](.*)["']$/, '$1')
  if (ROLES.has(sel)) return { role: sel, name: '' }
  const m = sel.match(/^(\w+)\s+(.+)$/)
  if (m && ROLES.has(m[1])) return { role: m[1], name: unquote(m[2]) }
  return { name: unquote(sel) }
}

async function resolve(wc: WebContents, raw: string, requireVisible = true): Promise<Resolved> {
  const s = parseSelector(raw)
  if (s.ref) return { kind: 'node', backendNodeId: refNode(wc, s.ref) }
  if (s.css || s.text) {
    const found = (await wc.executeJavaScript(locateJs({ selector: s.css, text: s.text }))) as { x: number; y: number } | null
    if (!found) throw new Error(`Nie znaleziono: ${raw}`)
    return { kind: 'dom', ...found }
  }
  let id = await axFind(wc, { role: s.role, name: s.name! }, requireVisible)
  if (!id && s.fuzzy) {
    const near = await axCandidates(wc, s.role, s.name, 2, true).catch(() => [])
    if (near.length === 1) {
      const m = near[0].match(/^(\w+) "(.*)"$/)
      if (m) id = await axFind(wc, { role: m[1], name: m[2] }, requireVisible)
      if (id) fuzzyNotes.push(`~ "${s.name}" dopasowano do ${near[0]}`)
    }
  }
  if (!id) {
    const hint = await axCandidates(wc, s.role, s.name).catch(() => [])
    throw new Error(`Nie znaleziono${requireVisible ? ' widocznego' : ''} elementu: ${raw}${hint.length ? `\n   dostępne ${s.role ?? 'interaktywne'}: ${hint.join(', ')}` : ''}`)
  }
  return { kind: 'node', backendNodeId: id }
}

/** Resolves a selector to click coordinates plus a hit-test of that point */
async function point(wc: WebContents, raw: string, node?: number): Promise<{ x: number; y: number; backendNodeId?: number; hit: Extra['hit'] }> {
  const r: Resolved = node ? { kind: 'node', backendNodeId: node } : await resolve(wc, raw)
  if (r.kind === 'dom') {
    const x = Math.round(r.x)
    const y = Math.round(r.y)
    return { x, y, hit: await wc.executeJavaScript(hitJs(x, y)) }
  }
  const p = await nodePoint(wc, r.backendNodeId)
  const x = Math.round(p.x)
  const y = Math.round(p.y)
  return { x, y, backendNodeId: r.backendNodeId, hit: await hitForRef(wc, r.backendNodeId, x, y) }
}

// ---------- scoping: --within / --near / --nth / --all ----------

interface Scope {
  within?: string
  near?: string
  nth?: number
  all?: boolean
}

/** Backend node ids of DOM elements produced by a page expression returning an array */
async function jsElements(wc: WebContents, expression: string): Promise<number[]> {
  const { result } = await cdp<{ result: { objectId?: string } }>(wc, 'Runtime.evaluate', { expression, returnByValue: false })
  if (!result.objectId) return []
  const { result: props } = await cdp<{ result: Array<{ name: string; value?: { objectId?: string } }> }>(wc, 'Runtime.getProperties', {
    objectId: result.objectId,
    ownProperties: true
  })
  const ids: number[] = []
  for (const pr of props) {
    if (!/^\d+$/.test(pr.name) || !pr.value?.objectId) continue
    const { node } = await cdp<{ node: { backendNodeId: number } }>(wc, 'DOM.describeNode', { objectId: pr.value.objectId })
    ids.push(node.backendNodeId)
  }
  return ids
}

/** Every element a selector matches (visible ones for role/name lookups) */
async function nodeList(wc: WebContents, raw: string): Promise<number[]> {
  const s = parseSelector(raw)
  await cdp(wc, 'DOM.enable')
  if (s.ref) return [refNode(wc, s.ref)]
  if (s.css) return jsElements(wc, `[...document.querySelectorAll(${JSON.stringify(s.css)})]`)
  if (s.text)
    // Smallest elements containing the text (not every ancestor up to <body>)
    return jsElements(
      wc,
      `(() => { const w = ${JSON.stringify(s.text.toLowerCase())}; const has = (e) => (e.innerText || '').toLowerCase().includes(w);
        return [...document.body.querySelectorAll('*')].filter((e) => has(e) && ![...e.children].some(has) && e.getClientRects().length) })()`
    )
  return axFindAll(wc, { role: s.role, name: s.name ?? '' })
}

/**
 * Narrows target candidates: --within keeps descendants of the container, --near picks
 * for each anchor the candidate sharing the deepest common ancestor (same card/row),
 * --nth picks one, --all keeps one per anchor.
 */
async function scoped(wc: WebContents, raw: string, scope: Scope): Promise<number[]> {
  let targets = await nodeList(wc, raw)
  if (!targets.length) return []
  const objects = async (ids: number[]): Promise<Array<{ objectId: string }>> =>
    Promise.all(ids.map(async (backendNodeId) => ({ objectId: (await cdp<{ object: { objectId: string } }>(wc, 'DOM.resolveNode', { backendNodeId })).object.objectId })))

  if (scope.within) {
    const containers = await nodeList(wc, scope.within)
    if (!containers.length) throw new Error(`--within: nie znaleziono ${scope.within}`)
    const [container] = await objects([containers[0]])
    const tObjs = await objects(targets)
    const { result } = await cdp<{ result: { value: boolean[] } }>(wc, 'Runtime.callFunctionOn', {
      objectId: container.objectId,
      functionDeclaration: 'function (...els) { return els.map((e) => this.contains(e)) }',
      arguments: tObjs,
      returnByValue: true
    })
    targets = targets.filter((_, i) => result.value[i])
  }

  if (scope.near) {
    const anchors = await nodeList(wc, scope.near)
    if (!anchors.length) throw new Error(`--near: nie znaleziono ${scope.near}`)
    const aObjs = await objects(anchors)
    const tObjs = await objects(targets)
    const { result } = await cdp<{ result: { value: number[] } }>(wc, 'Runtime.callFunctionOn', {
      objectId: aObjs[0].objectId,
      functionDeclaration: `function (nA, ...els) {
        const anchors = els.slice(0, nA), targets = els.slice(nA);
        const depth = (e) => { let d = 0; while (e) { d++; e = e.parentElement } return d };
        const lca = (a, b) => { const seen = new Set(); for (let x = a; x; x = x.parentElement) seen.add(x); for (let y = b; y; y = y.parentElement) if (seen.has(y)) return y; return null };
        return anchors.map((a) => {
          let best = -1, bestD = -1;
          targets.forEach((t, i) => { const c = lca(a, t); const d = c ? depth(c) : 0; if (d > bestD) { bestD = d; best = i } });
          return best;
        });
      }`,
      arguments: [{ value: anchors.length }, ...aObjs, ...tObjs],
      returnByValue: true
    })
    const picked = [...new Set(result.value.filter((i) => i >= 0))].map((i) => targets[i])
    targets = scope.all ? picked : picked.slice(0, 1)
  }

  if (!targets.length) return []
  if (scope.nth) {
    const one = targets[scope.nth - 1]
    if (!one) throw new Error(`--nth ${scope.nth}: jest tylko ${targets.length} dopasowań`)
    return [one]
  }
  return scope.all ? targets : targets.slice(0, 1)
}

const hasScope = (s: Scope): boolean => !!(s.within || s.near || s.nth || s.all)

/** Marks the editable element at/inside a DOM node (the node itself, or an input in a wrapper) */
const MARK_EDITABLE_FN = `function () {
  const isEditable = (e) => e && (e.matches('input:not([type=hidden]):not([type=checkbox]):not([type=radio]),textarea,select') || e.isContentEditable);
  let el = isEditable(this) ? this : this.querySelector('input:not([type=hidden]):not([type=checkbox]):not([type=radio]),textarea,[contenteditable=""],[contenteditable="true"]');
  // Some editors (Keep, Docs) only turn contenteditable on after a click: accept a focusable text-field role
  if (!el && this.matches('[role=textbox],[role=combobox],[role=searchbox],[tabindex]')) el = this;
  if (!el) return false;
  document.querySelectorAll('[data-drift-target]').forEach((e) => e.removeAttribute('data-drift-target'));
  el.setAttribute('data-drift-target', '1');
  el.scrollIntoView({ block: 'nearest' });
  return true;
}`

/** Like point(), but aims at the actual editable field, never a wrapper */
async function editablePoint(wc: WebContents, raw: string, node?: number): Promise<Awaited<ReturnType<typeof point>>> {
  const r: Resolved = node ? { kind: 'node', backendNodeId: node } : await resolve(wc, raw)
  let marked = false
  if (r.kind === 'node') {
    const { object } = (await wc.debugger.sendCommand('DOM.resolveNode', { backendNodeId: r.backendNodeId })) as { object: { objectId: string } }
    const { result } = (await wc.debugger.sendCommand('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: MARK_EDITABLE_FN,
      returnByValue: true
    })) as { result: { value: boolean } }
    marked = result.value
  } else {
    marked = await wc.executeJavaScript(`(${MARK_EDITABLE_FN}).call(document.querySelector('[data-drift-target]'))`)
  }
  if (!marked) throw new Error(`${raw} nie jest polem tekstowym i nie zawiera żadnego`)
  const box = (await wc.executeJavaScript(
    `(() => { const r = document.querySelector('[data-drift-target]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`
  )) as { x: number; y: number }
  const x = Math.round(box.x)
  const y = Math.round(box.y)
  return { x, y, hit: await wc.executeJavaScript(hitJs(x, y)) }
}

/** After the click: make sure the field has focus, replace its content, verify the result */
async function fillFocused(wc: WebContents, value: string): Promise<string> {
  await sleep(50)
  const focus = (await wc.executeJavaScript(`(() => {
    const t = document.querySelector('[data-drift-target]');
    const a = document.activeElement;
    if (t && a !== t && !t.contains(a)) t.focus();
    const e = document.activeElement;
    if (!t || (e !== t && !t.contains(e))) return { ok: false, active: e ? e.tagName.toLowerCase() : 'nic' };
    if (typeof e.select === 'function') e.select();
    else if (e.isContentEditable) document.getSelection().selectAllChildren(e);
    else return { ok: false, active: e.tagName.toLowerCase() + ' (nieedytowalny po kliknięciu)' };
    return { ok: true };
  })()`)) as { ok: boolean; active?: string }
  if (!focus.ok) throw new Error(`Po kliknięciu fokus jest na ${focus.active}, nie na polu — nic nie wpisano`)
  wc.insertText(value)
  await sleep(50)
  const now = String(
    await wc.executeJavaScript(`(() => { const t = document.querySelector('[data-drift-target]'); return t ? (t.value ?? t.innerText ?? '') : '' })()`)
  )
  if (!now.includes(value.slice(0, 20))) throw new Error(`Pole zawiera ${JSON.stringify(now.slice(0, 60))} zamiast wpisanego tekstu`)
  return `wpisano ${JSON.stringify(now.length > 60 ? now.slice(0, 60) + '…' : now)}`
}

// ---------- status, diff, wait ----------

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function diff(before: Status, after: Status): string[] {
  const out: string[] = []
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  // For most tabs the sidebar title is the page title: show it once
  if (before.title !== after.title) keys.delete('tab')
  for (const k of keys) {
    if (before[k] !== after[k]) out.push(`${k}: ${fmt(before[k])} → ${fmt(after[k])}`)
  }
  return out
}

const fmt = (v: unknown): string => (v === null || v === undefined ? '∅' : typeof v === 'string' ? JSON.stringify(v.length > 70 ? `${v.slice(0, 70)}…` : v) : String(v))

/** Waits until the status stops changing (animations, navigation start) */
async function settle(ctx: ControlContext, maxMs = 1500): Promise<Status> {
  const start = Date.now()
  let last = JSON.stringify(ctx.status())
  let stableSince = Date.now()
  while (Date.now() - start < maxMs) {
    await sleep(40)
    const now = JSON.stringify(ctx.status())
    if (now !== last) {
      last = now
      stableSince = Date.now()
    } else if (Date.now() - stableSince >= 160 && !ctx.status().animating) break
  }
  return ctx.status()
}

interface Condition {
  key: string
  op: '=' | '!=' | '~' | '!~'
  value: string
}

function parseCondition(raw: string): Condition {
  // Bare keys: "idle" (page settled) — optionally idle=<ms of quiet>
  if (/^idle$/.test(raw.trim())) return { key: 'idle', op: '=', value: '500' }
  const m = raw.match(/^([\w.]+)\s*(!=|!~|=|~)\s*(.*)$/)
  if (!m) throw new Error(`Zły warunek "${raw}" — użyj klucz=wartość, klucz!=wartość, klucz~fragment albo klucz!~fragment`)
  return { key: m[1], op: m[2] as Condition['op'], value: m[3] }
}

/** Last time each page started a network request (for the idle condition) */
const lastRequest = new WeakMap<WebContents, number>()

async function trackNetwork(wc: WebContents): Promise<void> {
  if (lastRequest.has(wc)) return
  lastRequest.set(wc, Date.now())
  await cdp(wc, 'Network.enable')
  wc.debugger.on('message', (_e, method) => {
    if (method === 'Network.requestWillBeSent') lastRequest.set(wc, Date.now())
  })
}

/** Page settled: no new requests for `quietMs` and no DOM changes for 300 ms */
async function isIdle(wc: WebContents, quietMs: number): Promise<boolean> {
  await trackNetwork(wc)
  if (Date.now() - (lastRequest.get(wc) ?? 0) < quietMs) return false
  const sinceMutation = Number(
    await wc
      .executeJavaScript(
        `(() => { if (!window.__driftMut) { window.__driftMut = performance.now(); new MutationObserver(() => (window.__driftMut = performance.now())).observe(document, { subtree: true, childList: true, characterData: true }) } return performance.now() - window.__driftMut })()`
      )
      .catch(() => 0)
  )
  return sinceMutation >= 300 && !wc.isLoading()
}

async function checkCondition(ctx: ControlContext, c: Condition, target: Target): Promise<boolean> {
  if (c.key === 'idle') {
    const wc = ctx.target(target)
    return !!wc && (await isIdle(wc, Number(c.value) || 500))
  }
  if (c.key === 'heading') {
    const wc = ctx.target(target)
    if (!wc) return false
    const text = String(
      await wc
        .executeJavaScript(`[...document.querySelectorAll('h1,h2,h3,[role=heading]')].filter((e) => e.getClientRects().length).map((e) => e.innerText).join('\\n')`)
        .catch(() => '')
    ).toLowerCase()
    const has = c.op === '=' ? text.split('\n').some((l) => l.trim() === c.value.toLowerCase()) : text.includes(c.value.toLowerCase())
    return c.op.startsWith('!') ? !has : has
  }
  if (c.key === 'el') {
    const wc = ctx.target(target)
    if (!wc) return false
    const found = await resolve(wc, c.value).then(
      () => true,
      () => false
    )
    return c.op.startsWith('!') ? !found : found
  }
  if (c.key === 'text') {
    const wc = ctx.target(target)
    if (!wc) return false
    const body = String(await wc.executeJavaScript('document.body.innerText').catch(() => '')).toLowerCase()
    const has = body.includes(c.value.toLowerCase())
    return c.op.startsWith('!') ? !has : has
  }
  if (c.key === 'selector') {
    const wc = ctx.target(target)
    if (!wc) return false
    const found = await wc
      .executeJavaScript(`(() => { const e = document.querySelector(${JSON.stringify(c.value)}); if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 })()`)
      .catch(() => false)
    return c.op.startsWith('!') ? !found : !!found
  }
  const actual = String(ctx.status()[c.key] ?? '')
  if (c.op === '=') return actual === c.value
  if (c.op === '!=') return actual !== c.value
  const has = actual.toLowerCase().includes(c.value.toLowerCase())
  return c.op === '!~' ? !has : has
}

// ---------- commands ----------

type Modifier = 'shift' | 'control' | 'alt' | 'meta' | 'cmd'
const mods = (list?: Modifier[]): Array<'shift' | 'control' | 'alt' | 'meta'> => (list ?? []).map((m) => (m === 'cmd' ? 'meta' : m))

function findMenuItem(items: MenuItem[], label: string): MenuItem | null {
  for (const item of items) {
    if (item.label.toLowerCase() === label.toLowerCase()) return item
    const sub = item.submenu ? findMenuItem(item.submenu.items, label) : null
    if (sub) return sub
  }
  return null
}

/** Commands that change something get an automatic before/after report */
const MUTATING = new Set(['action', 'menu', 'click', 'hover', 'mouse', 'type', 'key', 'fill', 'open'])

interface Extra {
  hit?: { ok: boolean; hit: string; target: string | null }
}

async function run(ctx: ControlContext, method: string, p: Record<string, unknown>, extra: Extra): Promise<unknown> {
  const targetName = ((p.target as Target) ?? 'sidebar') as Target
  const wc = (): WebContents => {
    const t = ctx.target(targetName)
    if (!t) throw new Error(`Brak widoku: ${targetName}`)
    return t
  }

  switch (method) {
    case 'state':
      return ctx.summary()
    case 'status':
      return ctx.status()
    case 'action': {
      const fn = ctx.actions[p.name as string]
      if (!fn) throw new Error(`Nieznana akcja. Dostępne: ${Object.keys(ctx.actions).join(', ')}`)
      return (await fn(...((p.args as unknown[]) ?? []))) ?? 'ok'
    }
    case 'menu': {
      const item = findMenuItem(Menu.getApplicationMenu()?.items ?? [], p.label as string)
      if (!item) throw new Error(`Brak pozycji menu: ${p.label}`)
      item.click()
      return 'ok'
    }
    case 'tree': {
      const target = wc()
      const root = p.within ? await resolve(target, p.within as string, false) : null
      if (root && root.kind !== 'node') throw new Error('--within dla tree wymaga selektora roli/nazwy albo ref')
      return await axTree(target, {
        all: !!p.all || !!root,
        filter: p.filter as string | undefined,
        rootBackendId: root?.kind === 'node' ? root.backendNodeId : undefined
      })
    }
    case 'text':
      return String(await wc().executeJavaScript('document.body.innerText')).slice(0, Number(p.limit ?? 8000))
    case 'eval':
      return await wc().executeJavaScript(p.code as string, true)
    case 'wait': {
      // conditions: AND within a group, OR between groups ("a b | c")
      const rawGroups = (p.conditions as unknown[]) ?? []
      const groups = (rawGroups.length && Array.isArray(rawGroups[0]) ? (rawGroups as string[][]) : [rawGroups as string[]]).map((g) => g.map(parseCondition))
      const failConds = ((p.fail as string[]) ?? []).map(parseCondition)
      if (!groups.flat().length) throw new Error('Podaj warunki, np. mode=edge url~/watch el=button Wyślij idle')
      const timeout = Number(p.timeout ?? 5000)
      const start = Date.now()
      const label = (c: Condition): string => (c.key === 'idle' ? 'idle' : `${c.key}${c.op}${c.value}`)
      let last: boolean[][] = []
      while (true) {
        for (const f of failConds) {
          if (await checkCondition(ctx, f, targetName)) throw new Error(`spełniony warunek porażki ${label(f)} po ${Date.now() - start} ms`)
        }
        last = await Promise.all(groups.map((g) => Promise.all(g.map((c) => checkCondition(ctx, c, targetName)))))
        const hit = last.findIndex((r) => r.every(Boolean))
        if (hit >= 0) return `spełnione po ${Date.now() - start} ms${groups.length > 1 ? ` (gałąź ${hit + 1}: ${groups[hit].map(label).join(' ')})` : ''}`
        if (Date.now() - start > timeout) break
        await sleep(50)
      }
      const failed = groups.flatMap((g, gi) => g.filter((_, i) => !last[gi]?.[i]))
      const desc = failed.map((c) => `${label(c)}${['el', 'text', 'selector', 'idle', 'heading'].includes(c.key) ? '' : ` (jest: ${fmt(ctx.status()[c.key])})`}`)
      // For a missing element, show what similar elements do exist (saves a lookup roundtrip)
      const hints: string[] = []
      for (const c of failed.filter((f) => f.key === 'el' && !f.op.startsWith('!'))) {
        const t = ctx.target(targetName)
        const q = parseSelector(c.value)
        if (t && q.name !== undefined) hints.push(...(await axCandidates(t, q.role, q.name).catch(() => [])))
      }
      throw new Error(`timeout ${timeout} ms, niespełnione: ${desc.join(', ')}${hints.length ? `\n   podobne: ${hints.join(', ')}` : ''}`)
    }
    case 'click':
    case 'hover':
    case 'fill': {
      let target = wc()
      const raw = (p.sel as string) ?? (p.ref ? String(p.ref) : p.selector ? `css:${p.selector}` : `text:${p.text}`)
      const scope: Scope = { within: p.within as string, near: p.near as string, nth: p.nth ? Number(p.nth) : undefined, all: !!p.all }
      // With a scope, candidates are picked up front; each is then clicked like a single target
      let nodes: Array<number | undefined> = [undefined]
      if (hasScope(scope)) {
        const found = await scoped(target, raw, scope)
        if (!found.length) {
          const q = parseSelector(raw)
          const hint = q.name !== undefined ? await axCandidates(target, q.role, q.name).catch(() => []) : []
          throw new Error(`Nie znaleziono ${raw} w zawężeniu${hint.length ? `\n   podobne na stronie: ${hint.join(', ')}` : ''}`)
        }
        nodes = found
      }
      const done: string[] = []
      for (const node of nodes) {
        const locate = (): ReturnType<typeof point> => (method === 'fill' ? editablePoint(target, raw, node) : point(target, raw, node))
        let pt = await locate()
        // Compact sidebar: slide it in instead of clicking into the void
        if (targetName === 'sidebar' && !pt.hit?.ok && ctx.status().mode === 'edge') {
          await ctx.revealSidebar()
          target = wc()
          pt = await locate()
        }
        // Menus and popovers often animate in: give an occluded target a moment to settle
        for (let i = 0; i < 6 && pt.hit && !pt.hit.ok && pt.hit.hit !== 'nic'; i++) {
          await sleep(120)
          pt = await locate()
        }
        // Hover-revealed controls (Keep, Gmail rows): move the mouse over first, then re-check
        if (pt.hit && !pt.hit.ok && pt.hit.hit !== 'nic') {
          target.sendInputEvent({ type: 'mouseMove', x: pt.x, y: pt.y })
          await sleep(150)
          pt = await locate()
        }
        extra.hit = pt.hit
        const { x, y } = pt
        if (extra.hit && !extra.hit.ok && !p.force) {
          const offscreen = extra.hit.hit === 'nic'
          throw new Error(
            (done.length ? `(${done.length} z ${nodes.length} wykonane) ` : '') +
              (offscreen
                ? `Cel ${extra.hit.target} jest poza widokiem (@${x},${y}) — nie klikam (--force wymusza)`
                : `Cel ${extra.hit.target} jest zasłonięty przez ${extra.hit.hit} — nie klikam (--force wymusza)`)
          )
        }
        target.sendInputEvent({ type: 'mouseMove', x, y })
        if (method === 'hover') {
          done.push(`mysz @${x},${y}`)
          continue
        }
        const button = (p.button as 'left' | 'right' | 'middle') ?? 'left'
        const base = { x, y, button, modifiers: mods(p.modifiers as Modifier[]) }
        target.sendInputEvent({ ...base, type: 'mouseDown', clickCount: 1 })
        target.sendInputEvent({ ...base, type: 'mouseUp', clickCount: 1 })
        if (p.double) {
          target.sendInputEvent({ ...base, type: 'mouseDown', clickCount: 2 })
          target.sendInputEvent({ ...base, type: 'mouseUp', clickCount: 2 })
        }
        if (method === 'click') done.push(`klik @${x},${y}`)
        else done.push(await fillFocused(target, String(p.value ?? '')))
        if (nodes.length > 1) await sleep(80)
      }
      return nodes.length > 1 ? `${done.length}×: ${done.join(', ')}` : done[0]
    }
    case 'snapshot': {
      const target = wc()
      // Containers (regions, dialogs) often have no box of their own: skip the visibility check
      const r = await resolve(target, p.sel as string, false)
      if (r.kind !== 'node') throw new Error('snapshot wymaga selektora roli/nazwy albo ref')
      return await axTree(target, { all: true, rootBackendId: r.backendNodeId, filter: p.filter as string | undefined })
    }
    case 'open': {
      const fn = ctx.actions['open-by-name']
      return await fn(p.name)
    }
    case 'mouse':
      wc().sendInputEvent({ type: 'mouseMove', x: Number(p.x), y: Number(p.y) })
      return 'ok'
    case 'type': {
      const target = wc()
      target.focus()
      target.insertText(p.text as string)
      return 'ok'
    }
    case 'key': {
      const target = wc()
      target.focus()
      const keyCode = p.key as string
      const modifiers = mods(p.modifiers as Modifier[])
      target.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
      if (keyCode.length === 1) target.sendInputEvent({ type: 'char', keyCode, modifiers })
      target.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
      return 'ok'
    }
    case 'screenshot': {
      const path = (p.path as string) ?? join(app.getPath('temp'), `drift-${targetName}.png`)
      writeFileSync(path, (await wc().capturePage()).toPNG())
      return path
    }
    case 'logs': {
      const out = logs.slice(-Number(p.limit ?? 50)).map((l) => l.line)
      if (p.clear) {
        logs.length = 0
        reported = logCounter
      }
      return out.join('\n')
    }
    default:
      throw new Error('Metody: state, status, action, menu, open, tree, snapshot, text, eval, wait, click, hover, fill, mouse, type, key, screenshot, logs, batch')
  }
}

async function batch(ctx: ControlContext, steps: Array<{ method: string; params: Record<string, unknown>; line?: string }>): Promise<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  let ok = true
  for (const [i, step] of steps.entries()) {
    const r = await handle(ctx, step.method, step.params ?? {}, false)
    out.push({ step: i + 1, line: step.line ?? step.method, ...r })
    if (!r.ok) {
      ok = false
      break
    }
  }
  const response: Record<string, unknown> = { ok, steps: out, total: steps.length }
  const errors = newErrors()
  if (errors.length) response.errors = errors
  response.meta = { instance: INSTANCE, seq: ctx.seq() }
  return response
}

async function handle(ctx: ControlContext, method: string, p: Record<string, unknown>, withMeta = true): Promise<Record<string, unknown>> {
  const mutating = MUTATING.has(method)
  const before = mutating ? ctx.status() : null
  const extra: Extra = {}
  const response: Record<string, unknown> = {}
  fuzzyNotes = []
  try {
    response.result = await run(ctx, method, p, extra)
    response.ok = true
  } catch (err) {
    response.ok = false
    response.error = (err as Error).message
  }
  if (before) {
    const after = await settle(ctx)
    response.changes = diff(before, after)
  }
  if (extra.hit) response.hit = extra.hit
  if (fuzzyNotes.length) response.notes = fuzzyNotes
  if (withMeta) {
    const errors = newErrors()
    if (errors.length) response.errors = errors
    response.meta = { instance: INSTANCE, seq: ctx.seq() }
  }
  return response
}

export function startControl(ctx: ControlContext): void {
  const token = randomBytes(24).toString('hex')
  // Errors from before the first command are old news
  reported = logCounter
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end()
      return
    }
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', async () => {
      let payload: Record<string, unknown>
      try {
        const { method, params, steps } = JSON.parse(body || '{}')
        payload = method === 'batch' ? await batch(ctx, steps ?? []) : await handle(ctx, method, params ?? {})
      } catch (err) {
        payload = { ok: false, error: (err as Error).message, meta: { instance: INSTANCE, seq: ctx.seq() } }
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(payload))
    })
  })
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address() as AddressInfo
    writeFileSync(join(app.getPath('userData'), 'control.json'), JSON.stringify({ port, token, pid: process.pid, instance: INSTANCE }), { mode: 0o600 })
    console.log(`Kanał sterowania: 127.0.0.1:${port} (instancja ${INSTANCE})`)
  })
}
