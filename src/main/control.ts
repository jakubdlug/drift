import { app, Menu, type MenuItem, type WebContents } from 'electron'
import { randomBytes, randomUUID } from 'crypto'
import { writeFileSync } from 'fs'
import { createServer } from 'http'
import type { AddressInfo } from 'net'
import { join } from 'path'
import { axCandidates, axFind, axTree, nodePoint, refNode, ROLES } from './ax'

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
export function capturePageErrors(wc: WebContents): void {
  wc.on('console-message', (e) => {
    if (e.level === 'error') pushLog('error', `[page ${hostOf(wc.getURL())}] ${e.message.slice(0, 200)}`)
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
  const ok = !target || !!(hit && (hit === target || target.contains(hit) || hit.contains(target)));
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
      const ok = !!(hit && (hit === this || this.contains(hit) || hit.contains(this)));
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
type Resolved = { kind: 'node'; backendNodeId: number } | { kind: 'dom'; x: number; y: number }

function parseSelector(raw: string): { ref?: number; css?: string; text?: string; role?: string; name?: string } {
  const sel = raw.trim()
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
  const id = await axFind(wc, { role: s.role, name: s.name! }, requireVisible)
  if (!id) {
    const hint = await axCandidates(wc, s.role, s.name).catch(() => [])
    throw new Error(`Nie znaleziono${requireVisible ? ' widocznego' : ''} elementu: ${raw}${hint.length ? `\n   dostępne ${s.role ?? 'interaktywne'}: ${hint.join(', ')}` : ''}`)
  }
  return { kind: 'node', backendNodeId: id }
}

/** Resolves a selector to click coordinates plus a hit-test of that point */
async function point(wc: WebContents, raw: string): Promise<{ x: number; y: number; backendNodeId?: number; hit: Extra['hit'] }> {
  const r = await resolve(wc, raw)
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

// ---------- status, diff, wait ----------

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function diff(before: Status, after: Status): string[] {
  const out: string[] = []
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
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
  const m = raw.match(/^([\w.]+)\s*(!=|!~|=|~)\s*(.*)$/)
  if (!m) throw new Error(`Zły warunek "${raw}" — użyj klucz=wartość, klucz!=wartość, klucz~fragment albo klucz!~fragment`)
  return { key: m[1], op: m[2] as Condition['op'], value: m[3] }
}

async function checkCondition(ctx: ControlContext, c: Condition, target: Target): Promise<boolean> {
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
    case 'tree':
      return await axTree(wc(), { all: !!p.all, filter: p.filter as string | undefined })
    case 'text':
      return String(await wc().executeJavaScript('document.body.innerText')).slice(0, Number(p.limit ?? 8000))
    case 'eval':
      return await wc().executeJavaScript(p.code as string, true)
    case 'wait': {
      const conds = ((p.conditions as string[]) ?? []).map(parseCondition)
      if (!conds.length) throw new Error('Podaj warunki, np. mode=edge url~/watch selector=video')
      const timeout = Number(p.timeout ?? 5000)
      const start = Date.now()
      while (true) {
        const results = await Promise.all(conds.map((c) => checkCondition(ctx, c, targetName)))
        if (results.every(Boolean)) return `spełnione po ${Date.now() - start} ms`
        if (Date.now() - start > timeout) {
          const failed = conds.filter((_, i) => !results[i]).map((c) => `${c.key}${c.op}${c.value} (jest: ${fmt(ctx.status()[c.key])})`)
          throw new Error(`timeout ${timeout} ms, niespełnione: ${failed.join(', ')}`)
        }
        await sleep(50)
      }
    }
    case 'click':
    case 'hover':
    case 'fill': {
      let target = wc()
      const raw = (p.sel as string) ?? (p.ref ? String(p.ref) : p.selector ? `css:${p.selector}` : `text:${p.text}`)
      let pt = await point(target, raw)
      // Compact sidebar: slide it in instead of clicking into the void
      if (targetName === 'sidebar' && !pt.hit?.ok && ctx.status().mode === 'edge') {
        await ctx.revealSidebar()
        target = wc()
        pt = await point(target, raw)
      }
      extra.hit = pt.hit
      const { x, y } = pt
      if (extra.hit && !extra.hit.ok && !p.force) {
        const offscreen = extra.hit.hit === 'nic'
        throw new Error(
          offscreen
            ? `Cel ${extra.hit.target} jest poza widokiem (@${x},${y}) — nie klikam (--force wymusza)`
            : `Cel ${extra.hit.target} jest zasłonięty przez ${extra.hit.hit} — nie klikam (--force wymusza)`
        )
      }
      target.sendInputEvent({ type: 'mouseMove', x, y })
      if (method === 'hover') return `mysz @${x},${y}`
      const button = (p.button as 'left' | 'right' | 'middle') ?? 'left'
      const base = { x, y, button, modifiers: mods(p.modifiers as Modifier[]) }
      target.sendInputEvent({ ...base, type: 'mouseDown', clickCount: 1 })
      target.sendInputEvent({ ...base, type: 'mouseUp', clickCount: 1 })
      if (p.double) {
        target.sendInputEvent({ ...base, type: 'mouseDown', clickCount: 2 })
        target.sendInputEvent({ ...base, type: 'mouseUp', clickCount: 2 })
      }
      if (method === 'click') return `klik @${x},${y}`
      // fill: select the field's current content so the new text replaces it
      await sleep(60)
      await target.executeJavaScript(`(() => {
        const e = document.activeElement;
        if (!e) return;
        if ('select' in e && typeof e.select === 'function') e.select();
        else if (e.isContentEditable) document.getSelection().selectAllChildren(e);
      })()`)
      target.insertText(String(p.value ?? ''))
      await sleep(60)
      const now = String(
        await target.executeJavaScript(`(() => { const e = document.activeElement; return e ? (e.value ?? e.innerText ?? '') : '' })()`)
      )
      return `wpisano ${JSON.stringify(now.length > 60 ? now.slice(0, 60) + '…' : now)}`
    }
    case 'snapshot': {
      const target = wc()
      // Containers (regions, dialogs) often have no box of their own: skip the visibility check
      const r = await resolve(target, p.sel as string, false)
      if (r.kind !== 'node') throw new Error('snapshot wymaga selektora roli/nazwy albo ref')
      return await axTree(target, { all: true, rootBackendId: r.backendNodeId })
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
