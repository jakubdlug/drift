import { app, Menu, type MenuItem, type WebContents } from 'electron'
import { randomBytes } from 'crypto'
import { writeFileSync } from 'fs'
import { createServer } from 'http'
import type { AddressInfo } from 'net'
import { join } from 'path'

/**
 * Local automation channel: lets a coding agent (or scripts/drift-ctl) read
 * state, inspect the DOM as text and click/type without screenshots.
 * Bound to 127.0.0.1 and guarded by a random token stored with 0600 perms.
 */

export type Target = 'sidebar' | 'page' | 'find'

export interface ControlContext {
  target: (name: Target) => WebContents | null
  actions: Record<string, (...args: unknown[]) => unknown>
  summary: () => unknown
}

const LOG_LIMIT = 300
const logs: string[] = []

export function captureConsole(wc: WebContents, label: string): void {
  wc.on('console-message', (e) => pushLog(`[${label}] ${e.level}: ${e.message}`))
  wc.on('render-process-gone', (_e, d) => pushLog(`[${label}] crashed: ${d.reason}`))
}

function pushLog(line: string): void {
  logs.push(`${new Date().toISOString().slice(11, 19)} ${line}`)
  if (logs.length > LOG_LIMIT) logs.splice(0, logs.length - LOG_LIMIT)
}

/** Runs in the target page: tags interactive/visible elements with refs and lists them */
const TREE_JS = `(() => {
  const out = [];
  let n = 0;
  const interactive = 'a,button,input,textarea,select,summary,[role],[draggable="true"],[onclick],[tabindex]';
  document.querySelectorAll('[data-drift-ref]').forEach((el) => el.removeAttribute('data-drift-ref'));
  for (const el of document.querySelectorAll(interactive)) {
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (r.width < 2 || r.height < 2 || style.visibility === 'hidden' || style.display === 'none') continue;
    if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
    const ref = ++n;
    el.setAttribute('data-drift-ref', ref);
    const role = el.getAttribute('role') || el.tagName.toLowerCase();
    const label = (el.getAttribute('aria-label') || el.getAttribute('title') || el.value || el.placeholder || el.innerText || '')
      .replace(/\\s+/g, ' ').trim().slice(0, 80);
    const cls = typeof el.className === 'string' ? el.className.split(' ').filter((c) => c && !c.startsWith('svelte-')).slice(0, 3).join('.') : '';
    out.push('[' + ref + '] ' + role + (cls ? '.' + cls : '') + ' "' + label + '" @' + Math.round(r.x) + ',' + Math.round(r.y) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
    if (n >= 400) break;
  }
  return out.join('\\n');
})()`

const locateJs = (sel: { ref?: number; selector?: string; text?: string }): string => `(() => {
  const sel = ${JSON.stringify(sel)};
  let el = null;
  if (sel.ref) el = document.querySelector('[data-drift-ref="' + sel.ref + '"]');
  else if (sel.selector) el = document.querySelector(sel.selector);
  else if (sel.text) {
    const want = sel.text.toLowerCase();
    const all = [...document.querySelectorAll('a,button,input,[role],[draggable="true"],[tabindex],span,div')];
    el = all.find((e) => (e.innerText || e.value || e.title || '').trim().toLowerCase() === want)
      || all.find((e) => (e.innerText || e.value || e.title || '').toLowerCase().includes(want));
  }
  if (!el) return null;
  el.scrollIntoView({ block: 'nearest' });
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
})()`

type Modifier = 'shift' | 'control' | 'alt' | 'meta' | 'cmd'

function mods(list?: Modifier[]): Array<'shift' | 'control' | 'alt' | 'meta'> {
  return (list ?? []).map((m) => (m === 'cmd' ? 'meta' : m))
}

function findMenuItem(items: MenuItem[], label: string): MenuItem | null {
  for (const item of items) {
    if (item.label.toLowerCase() === label.toLowerCase()) return item
    const sub = item.submenu ? findMenuItem(item.submenu.items, label) : null
    if (sub) return sub
  }
  return null
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function handle(ctx: ControlContext, method: string, p: Record<string, unknown>): Promise<unknown> {
  const wc = (): WebContents => {
    const target = ctx.target((p.target as Target) ?? 'sidebar')
    if (!target) throw new Error(`Brak widoku: ${p.target ?? 'sidebar'}`)
    return target
  }

  switch (method) {
    case 'state':
      return ctx.summary()
    case 'action': {
      const fn = ctx.actions[p.name as string]
      if (!fn) throw new Error(`Nieznana akcja. Dostępne: ${Object.keys(ctx.actions).join(', ')}`)
      return await fn(...((p.args as unknown[]) ?? []))
    }
    case 'menu': {
      const item = findMenuItem(Menu.getApplicationMenu()?.items ?? [], p.label as string)
      if (!item) throw new Error(`Brak pozycji menu: ${p.label}`)
      item.click()
      return 'ok'
    }
    case 'tree':
      return await wc().executeJavaScript(TREE_JS)
    case 'text':
      return String(await wc().executeJavaScript('document.body.innerText')).slice(0, Number(p.limit ?? 8000))
    case 'eval':
      return await wc().executeJavaScript(p.code as string)
    case 'click': {
      const target = wc()
      const pt = (await target.executeJavaScript(locateJs(p as never))) as { x: number; y: number } | null
      if (!pt) throw new Error('Nie znaleziono elementu')
      const button = (p.button as 'left' | 'right' | 'middle') ?? 'left'
      const base = { x: Math.round(pt.x), y: Math.round(pt.y), button, modifiers: mods(p.modifiers as Modifier[]) }
      target.sendInputEvent({ type: 'mouseMove', x: base.x, y: base.y })
      target.sendInputEvent({ ...base, type: 'mouseDown', clickCount: 1 })
      target.sendInputEvent({ ...base, type: 'mouseUp', clickCount: 1 })
      if (p.double) {
        target.sendInputEvent({ ...base, type: 'mouseDown', clickCount: 2 })
        target.sendInputEvent({ ...base, type: 'mouseUp', clickCount: 2 })
      }
      await sleep(150)
      return `kliknięto @${base.x},${base.y}`
    }
    case 'hover': {
      const target = wc()
      const pt = (await target.executeJavaScript(locateJs(p as never))) as { x: number; y: number } | null
      if (!pt) throw new Error('Nie znaleziono elementu')
      target.sendInputEvent({ type: 'mouseMove', x: Math.round(pt.x), y: Math.round(pt.y) })
      return 'ok'
    }
    case 'mouse': {
      wc().sendInputEvent({ type: 'mouseMove', x: Number(p.x), y: Number(p.y) })
      return 'ok'
    }
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
      await sleep(100)
      return 'ok'
    }
    case 'screenshot': {
      const path = (p.path as string) ?? join(app.getPath('temp'), `drift-${p.target ?? 'sidebar'}.png`)
      writeFileSync(path, (await wc().capturePage()).toPNG())
      return path
    }
    case 'logs': {
      const out = logs.slice(-Number(p.limit ?? 50))
      if (p.clear) logs.length = 0
      return out.join('\n')
    }
    default:
      throw new Error('Metody: state, action, menu, tree, text, eval, click, hover, mouse, type, key, screenshot, logs')
  }
}

export function startControl(ctx: ControlContext): void {
  const token = randomBytes(24).toString('hex')
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end()
      return
    }
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', async () => {
      try {
        const { method, params } = JSON.parse(body || '{}')
        const result = await handle(ctx, method, params ?? {})
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, result }))
      } catch (err) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: (err as Error).message }))
      }
    })
  })
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address() as AddressInfo
    writeFileSync(join(app.getPath('userData'), 'control.json'), JSON.stringify({ port, token, pid: process.pid }), { mode: 0o600 })
    console.log(`Kanał sterowania: 127.0.0.1:${port}`)
  })
}
