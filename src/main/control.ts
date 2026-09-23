import { app, Menu, type MenuItem, type WebContents } from 'electron'
import { randomBytes, randomUUID } from 'crypto'
import { writeFileSync } from 'fs'
import { createServer } from 'http'
import type { AddressInfo } from 'net'
import { join } from 'path'
import { axTree, refPoint } from './ax'

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
  op: '=' | '!=' | '~'
  value: string
}

function parseCondition(raw: string): Condition {
  const m = raw.match(/^([\w.]+)\s*(!=|=|~)\s*(.*)$/)
  if (!m) throw new Error(`Zły warunek "${raw}" — użyj klucz=wartość, klucz!=wartość albo klucz~fragment`)
  return { key: m[1], op: m[2] as Condition['op'], value: m[3] }
}

async function checkCondition(ctx: ControlContext, c: Condition, target: Target): Promise<boolean> {
  if (c.key === 'selector') {
    const wc = ctx.target(target)
    if (!wc) return false
    const found = await wc
      .executeJavaScript(`(() => { const e = document.querySelector(${JSON.stringify(c.value)}); if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 })()`)
      .catch(() => false)
    return c.op === '!=' ? !found : !!found
  }
  const actual = String(ctx.status()[c.key] ?? '')
  if (c.op === '=') return actual === c.value
  if (c.op === '!=') return actual !== c.value
  return actual.toLowerCase().includes(c.value.toLowerCase())
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
const MUTATING = new Set(['action', 'menu', 'click', 'hover', 'mouse', 'type', 'key'])

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
    case 'hover': {
      const target = wc()
      let pt: { x: number; y: number }
      if (p.ref) {
        const r = await refPoint(target, Number(p.ref))
        pt = r
        extra.hit = await hitForRef(target, r.backendNodeId, Math.round(r.x), Math.round(r.y))
      } else {
        const found = (await target.executeJavaScript(locateJs(p as never))) as { x: number; y: number } | null
        if (!found) throw new Error('Nie znaleziono elementu')
        pt = found
        extra.hit = await target.executeJavaScript(hitJs(Math.round(found.x), Math.round(found.y)))
      }
      const x = Math.round(pt.x)
      const y = Math.round(pt.y)
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
      return `klik @${x},${y}`
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
      throw new Error('Metody: state, status, action, menu, tree, text, eval, wait, click, hover, mouse, type, key, screenshot, logs')
  }
}

async function handle(ctx: ControlContext, method: string, p: Record<string, unknown>): Promise<Record<string, unknown>> {
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
  const errors = newErrors()
  if (errors.length) response.errors = errors
  response.meta = { instance: INSTANCE, seq: ctx.seq() }
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
        const { method, params } = JSON.parse(body || '{}')
        payload = await handle(ctx, method, params ?? {})
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
