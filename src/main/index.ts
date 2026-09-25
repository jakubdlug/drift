import { app, BaseWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, shell, WebContentsView, webContents } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import type { ChromeMode, DropTarget, ItemId, Snapshot, Workspace } from '@shared/types'
import { arcAvailable, copyStorage, importCookies, importHistory, importSidebar } from './arc-import'
import { captureConsole, capturePageErrors, startControl, type Status } from './control'
import { buildMenu } from './menu'
import { count as passwordCount, fillLoginInteractive, importCsv } from './passwords'
import { saveStateNow, statePath, Store } from './store'
import { TabManager } from './tabs'

const GAP = 8
const PEEK_SHADOW = 16

// Stack traces point at src/… instead of line numbers in the bundle
process.setSourceMapsEnabled(true)

app.setName('Drift')
nativeTheme.themeSource = 'dark'

/**
 * Two instances would share (and corrupt) the same session databases. In dev the
 * watcher restarts us right after killing the old process, so wait for its lock.
 */
async function acquireInstanceLock(): Promise<boolean> {
  const deadline = Date.now() + (app.isPackaged ? 0 : 8000)
  while (!app.requestSingleInstanceLock()) {
    if (Date.now() > deadline) return false
    await new Promise((r) => setTimeout(r, 200))
  }
  return true
}

// Watchers and scripts stop us with SIGTERM; quit properly so state gets flushed
process.on('SIGTERM', () => app.quit())
// Same for synchronous throws in event handlers: log instead of Electron's modal error dialog
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err)
  try {
    layout()
    push()
  } catch {}
})
// A failing handler must not leave the window half-updated: log, then re-sync the UI
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err)
  try {
    layout()
    push()
  } catch {}
})

app.on('second-instance', (_e, argv) => {
  if (!win) return
  win.show()
  win.focus()
  for (const arg of argv.slice(1)) if (/^https?:\/\//.test(arg)) newTab(arg)
})

let win: BaseWindow
let chrome: WebContentsView
let tabs: TabManager
let store: Store
let mode: ChromeMode = 'docked'
/** Workspace used before the current one: where deleting a workspace returns to */
let previousWorkspaceId: string | null = null
/** A page (e.g. a video) requested fullscreen: the tab covers the whole window */
let htmlFullscreen = false
let fullscreenedForPage = false
/** Find-in-page bar; created on ⌘F and destroyed on close to save a renderer */
let findView: WebContentsView | null = null
const FIND_W = 380
const FIND_H = 52
/** 1 = sidebar docked, 0 = hidden; animated between the two on ⌘S */
let reveal = 1
/** Bumped on every state or tab change; lets control clients spot unexpected changes */
let seq = 0
/** Sidebar-local UI state reported by the renderer (peek, palette, focus…) */
let ui: Record<string, string | number | boolean | null> = {}
let revealTimer: NodeJS.Timeout | null = null
const REVEAL_MS = 220

// ---------- layout ----------

function layout(): void {
  if (!win || win.isDestroyed()) return
  const [w, h] = win.getContentSize()
  if (htmlFullscreen) {
    chrome.setBounds({ x: 0, y: 0, width: 0, height: 0 })
    tabs.activeView?.setBounds({ x: 0, y: 0, width: w, height: h })
    tabs.activeView?.setBorderRadius(0)
    return
  }
  const sw = store.state.settings.sidebarWidth
  const fullscreen = win.isFullScreen()
  const gap = fullscreen && reveal === 0 ? 0 : GAP

  const chromeBounds = {
    // While animating, the docked sidebar slides out to the left in step with the page
    docked: { x: Math.round(-sw * (1 - reveal)), y: 0, width: sw, height: h },
    edge: { x: 0, y: 0, width: GAP, height: h },
    peek: { x: 0, y: 0, width: sw + PEEK_SHADOW, height: h },
    full: { x: 0, y: 0, width: w, height: h }
  }[mode]
  // No page to show (empty workspace): the sidebar view draws an empty state over the whole window
  chrome.setBounds(tabs.activeView ? chromeBounds : { x: 0, y: 0, width: w, height: h })

  const left = Math.round(gap + (sw - gap) * reveal)
  tabs.activeView?.setBounds({ x: left, y: gap, width: Math.max(0, w - left - gap), height: Math.max(0, h - gap * 2) })
  tabs.activeView?.setBorderRadius(gap ? 8 : 0)
  findView?.setBounds({ x: w - FIND_W - gap - 8, y: gap + 8, width: FIND_W, height: FIND_H })

  // Traffic lights live in the sidebar, so they hide with it
  win.setWindowButtonVisibility(mode !== 'edge')
  // Keep the sidebar and find bar above the page
  win.contentView.addChildView(chrome)
  if (findView) win.contentView.addChildView(findView)
}

function loadRenderer(view: WebContentsView, hash = ''): void {
  if (process.env.ELECTRON_RENDERER_URL) view.webContents.loadURL(`${process.env.ELECTRON_RENDERER_URL}#${hash}`)
  else view.webContents.loadFile(join(__dirname, '../renderer/index.html'), { hash })
}

function openFind(): void {
  if (!tabs.webContents()) return
  if (findView) {
    findView.webContents.focus()
    findView.webContents.send('command', { type: 'find-focus' })
    return
  }
  findView = new WebContentsView({
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false, contextIsolation: true }
  })
  findView.setBackgroundColor('#00000000')
  captureConsole(findView.webContents, 'find')
  loadRenderer(findView, 'find')
  findView.webContents.once('did-finish-load', () => {
    if (findView && !findView.webContents.isDestroyed()) findView.webContents.focus()
  })
  layout()
}

function closeFind(): void {
  if (!findView) return
  tabs.webContents()?.stopFindInPage('clearSelection')
  win.contentView.removeChildView(findView)
  findView.webContents.close()
  findView = null
  tabs.webContents()?.focus()
}

function findStep(forward: boolean): void {
  if (findView) findView.webContents.send('command', { type: forward ? 'find-next' : 'find-prev' })
  else openFind()
}

function setMode(next: ChromeMode): void {
  if (next === mode) return
  mode = next
  layout()
  push()
}

function applyCompact(): void {
  setMode(store.state.settings.compact ? 'edge' : 'docked')
}

// ---------- state → renderer ----------

let pushTimer: NodeJS.Timeout | null = null
function push(): void {
  seq++
  if (pushTimer) return
  pushTimer = setTimeout(() => {
    pushTimer = null
    if (chrome.webContents.isDestroyed()) return
    const snapshot: Snapshot = { state: store.state, tabs: tabs.runtime(), mode, hasPage: !!tabs.activeView }
    chrome.webContents.send('snapshot', snapshot)
    win.setBackgroundColor(store.activeWorkspace.color)
  }, 8)
}

// ---------- actions ----------

function normaliseInput(input: string): string {
  const text = input.trim()
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^(about|data|file|chrome|view-source):/i.test(text)) return text
  if (/^localhost(:\d+)?(\/|$)/.test(text) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(text)) return `http://${text}`
  if (!/\s/.test(text) && /^[^/]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(text)) return `https://${text}`
  return store.state.settings.searchUrl.replace('%s', encodeURIComponent(text))
}

function openItem(id: ItemId): void {
  const item = store.state.items[id]
  if (!item) return
  if (item.kind === 'folder') {
    store.update(id, { collapsed: !item.collapsed })
    return
  }
  if (id !== activeItemId()) closeFind()
  store.setActive(store.activeWorkspace.id, id)
  tabs.show(id)
}

function newTab(input: string, workspace: Workspace = store.activeWorkspace, focus = true, incognito = false): ItemId {
  const url = normaliseInput(input)
  const item = store.createTab(url, url, workspace, incognito)
  if (focus) openItem(item.id)
  return item.id
}

/** Cmd+W semantics: today tabs are archived, saved ones just unload */
function closeItem(id: ItemId): void {
  const ws = store.activeWorkspace
  const wasActive = store.state.activeItemByWorkspace[ws.id] === id
  let next: ItemId | null = null
  if (wasActive) {
    // Like Chrome/Arc: go back to the tab used before this one, else a neighbour in Today
    const prev = store.previousActive[ws.id]
    if (prev && prev !== id && store.state.items[prev]) next = prev
    else if (store.isToday(id)) {
      const i = ws.today.indexOf(id)
      next = ws.today[i + 1] ?? ws.today[i - 1] ?? null
    }
  }
  tabs.close(id)
  if (store.isToday(id)) store.archive(id)
  if (wasActive) {
    store.setActive(ws.id, null)
    if (next) openItem(next)
  }
  push()
}

function activeItemId(): ItemId | null {
  return store.state.activeItemByWorkspace[store.activeWorkspace.id] ?? null
}

function switchWorkspace(id: string): void {
  if (!store.workspace(id) || id === store.state.activeWorkspaceId) return
  closeFind()
  tabs.detach()
  previousWorkspaceId = store.state.activeWorkspaceId
  store.state.activeWorkspaceId = id
  store.changed()
  const active = activeItemId()
  if (active) tabs.show(active)
  layout()
  push()
}

function cycleWorkspace(delta: number): void {
  const list = store.state.workspaces
  const i = list.findIndex((w) => w.id === store.state.activeWorkspaceId)
  switchWorkspace(list[(i + delta + list.length) % list.length].id)
}

/** Sidebar order used by ⌘1…9 and next/previous tab: Essentials, pinned (expanded folders), Today */
function tabOrder(): ItemId[] {
  const s = store.state
  const ws = store.activeWorkspace
  const flatten = (ids: ItemId[]): ItemId[] =>
    ids.flatMap((id) => {
      const it = s.items[id]
      if (!it) return []
      if (it.kind === 'folder') return it.collapsed ? [] : flatten(it.children ?? [])
      return [id]
    })
  return [...flatten(s.essentials[ws.profileId] ?? []), ...flatten(ws.pinned), ...ws.today.filter((id) => s.items[id])]
}

function selectTabAt(index: number): void {
  const order = tabOrder()
  const id = index < 0 ? order[order.length - 1] : order[index]
  if (id) openItem(id)
}

function cycleTab(delta: number): void {
  const order = tabOrder()
  if (!order.length) return
  const i = order.indexOf(activeItemId() ?? '')
  openItem(order[(i + delta + order.length) % order.length])
}

function duplicateTab(): void {
  const id = activeItemId()
  const url = id ? (tabs.runtime()[id]?.url ?? store.state.items[id]?.url) : undefined
  if (url) newTab(url, store.activeWorkspace, true, !!store.state.items[id!]?.incognito)
}

function togglePin(id: ItemId): void {
  if (store.isToday(id)) store.move(id, { zone: 'pinned', index: store.activeWorkspace.pinned.length })
  else store.move(id, { zone: 'today', index: 0 })
}

function archiveStale(): void {
  const limit = store.state.settings.archiveAfterHours * 3_600_000
  const now = Date.now()
  const active = new Set(Object.values(store.state.activeItemByWorkspace))
  for (const ws of store.state.workspaces) {
    for (const id of [...ws.today]) {
      const item = store.state.items[id]
      if (!item || active.has(id) || tabs.runtime()[id]?.audible) continue
      if (now - (item.lastActiveAt ?? item.createdAt) > limit) {
        tabs.close(id)
        store.archive(id)
      }
    }
  }
}

function suggest(query: string): Array<{ kind: 'tab' | 'history'; id?: ItemId; url: string; title: string; favicon?: string }> {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const words = q.split(/\s+/)
  const matches = (s: string): boolean => words.every((w) => s.includes(w))
  const seen = new Set<string>()
  const out: ReturnType<typeof suggest> = []

  const ws = store.activeWorkspace
  const reachable = [...(store.state.essentials[ws.profileId] ?? []), ...ws.pinned, ...ws.today]
  const collect = (ids: ItemId[]): void => {
    for (const id of ids) {
      const it = store.state.items[id]
      if (!it) continue
      if (it.kind === 'folder') collect(it.children ?? [])
      else if (it.url && matches(`${it.title} ${it.url}`.toLowerCase())) {
        out.push({ kind: 'tab', id, url: it.url, title: it.title, favicon: it.favicon })
        seen.add(it.url)
      }
    }
  }
  collect(reachable)

  const now = Date.now()
  const scored = store.history
    .filter((h) => !seen.has(h.url) && matches(`${h.title} ${h.url}`.toLowerCase()))
    .map((h) => {
      const ageDays = (now - h.lastVisit) / 86_400_000
      const hostHit = new URL(h.url).hostname.includes(words[0]) ? 20 : 0
      return { h, score: Math.log2(h.visits + 1) * 10 - Math.min(ageDays, 60) / 3 + hostHit - h.url.length / 40 }
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
  for (const { h } of scored) out.push({ kind: 'history', url: h.url, title: h.title || h.url })
  return out.slice(0, 10)
}

function itemMenu(id: ItemId): void {
  const item = store.state.items[id]
  if (!item) return
  const loc = store.locate(id)
  const isTab = item.kind === 'tab'
  const loaded = tabs.isLoaded(id)
  const template: Electron.MenuItemConstructorOptions[] = [
    { label: 'Rename', click: () => chrome.webContents.send('command', { type: 'rename', id }) },
    ...(isTab
      ? [
          { label: 'Copy link', click: () => clipboard.writeText(tabs.runtime()[id]?.url ?? item.url ?? '') },
          ...(loc?.zone !== 'today'
            ? [
                { label: 'Go back to saved URL', click: () => item.url && tabs.navigate(id, item.url) },
                {
                  label: 'Save current URL as default',
                  click: () => store.update(id, { url: tabs.runtime()[id]?.url ?? item.url })
                }
              ]
            : []),
          { type: 'separator' as const },
          loc?.zone === 'today'
            ? { label: 'Pin', click: () => togglePin(id) }
            : { label: 'Unpin to Today', click: () => togglePin(id) },
          ...(loc?.zone !== 'essentials'
            ? [{ label: 'Add to Essentials', click: () => store.move(id, { zone: 'essentials', index: 999 }) }]
            : []),
          ...(loaded ? [{ label: 'Sleep tab', click: () => tabs.sleep(id) }] : [])
        ]
      : [{ label: 'New subfolder', click: () => store.createFolder('New folder', { zone: 'folder', parentId: id, index: 0 }) }]),
    {
      label: 'Move to workspace',
      submenu: store.state.workspaces
        .filter((w) => w.id !== store.activeWorkspace.id && loc?.zone !== 'essentials')
        .map((w) => ({
          label: `${w.emoji ?? ''} ${w.name}`.trim(),
          click: () => {
            loc?.list.splice(loc.list.indexOf(id), 1)
            w.pinned.push(id)
            tabs.close(id)
            store.changed()
          }
        }))
    },
    { type: 'separator' },
    {
      label: item.kind === 'folder' ? 'Delete folder and its contents' : 'Delete',
      click: () => {
        for (const removed of store.remove(id)) tabs.close(removed)
        push()
      }
    }
  ]
  Menu.buildFromTemplate(template).popup({ window: win })
}

function workspaceMenu(id: string): void {
  const ws = store.workspace(id)
  if (!ws) return
  const profiles = store.state.profiles
  Menu.buildFromTemplate([
    { label: 'Rename / emoji', click: () => chrome.webContents.send('command', { type: 'edit-workspace', id }) },
    {
      label: 'Profile (session)',
      submenu: profiles.map((p) => ({
        label: p.name,
        type: 'radio' as const,
        checked: p.id === ws.profileId,
        click: () => {
          ws.profileId = p.id
          store.changed()
        }
      }))
    },
    { type: 'separator' },
    {
      label: 'Delete workspace',
      enabled: store.state.workspaces.length > 1,
      click: async () => {
        const { response } = await dialog.showMessageBox(win, {
          type: 'warning',
          message: `Delete workspace “${ws.name}” along with its pinned tabs?`,
          buttons: ['Cancel', 'Delete'],
          defaultId: 0
        })
        if (response === 1) deleteWorkspace(ws.id)
      }
    }
  ]).popup({ window: win })
}

/** Removes a workspace; if it was active, moves to a neighbour first so the view is never left empty */
function deleteWorkspace(id: string): void {
  const list = store.state.workspaces
  const index = list.findIndex((w) => w.id === id)
  if (index < 0 || list.length < 2) return
  const ws = list[index]
  if (store.state.activeWorkspaceId === id) {
    const fallback = list.find((w) => w.id === previousWorkspaceId && w.id !== id) ?? list[index - 1] ?? list[index + 1]
    try {
      switchWorkspace(fallback.id)
    } catch (err) {
      console.error('Switching workspace failed:', err)
      store.state.activeWorkspaceId = fallback.id
    }
  }
  for (const itemId of [...ws.pinned, ...ws.today]) for (const r of store.remove(itemId)) tabs.close(r)
  store.state.workspaces = store.state.workspaces.filter((w) => w.id !== id)
  delete store.state.activeItemByWorkspace[id]
  store.changed()
  layout()
}

function newWorkspace(): void {
  const current = store.activeWorkspace
  const ws: Workspace = {
    id: crypto.randomUUID(),
    name: 'New workspace',
    emoji: '✨',
    color: current.color,
    profileId: current.profileId,
    pinned: [],
    today: []
  }
  store.state.workspaces.push(ws)
  store.changed()
  switchWorkspace(ws.id)
  // After the snapshot with the new workspace has reached the sidebar (push is debounced)
  setTimeout(() => chrome.webContents.send('command', { type: 'edit-workspace', id: ws.id }), 60)
}

function tidyToday(): void {
  const ws = store.activeWorkspace
  const host = (id: ItemId): string => {
    try {
      return new URL(store.state.items[id]?.url ?? '').hostname.replace(/^www\./, '')
    } catch {
      return ''
    }
  }
  ws.today.sort((a, b) => host(a).localeCompare(host(b)))
  store.changed()
}

function clearToday(): void {
  const ws = store.activeWorkspace
  const active = activeItemId()
  for (const id of [...ws.today]) {
    if (id === active) continue
    tabs.close(id)
    store.archive(id)
  }
  push()
}

// ---------- IPC ----------

/** Every IPC action, also exposed to the local control channel */
const handlers: Record<string, (...args: unknown[]) => unknown> = {}
// Control channel only (not sidebar IPC): import a password CSV without the file dialog
handlers['import-passwords'] = (file: unknown) => importCsv(String(file))

function registerIpc(): void {
  const on = (channel: string, fn: (...args: never[]) => unknown): void => {
    handlers[channel] = fn as (...a: unknown[]) => unknown
    ipcMain.handle(channel, (_e, ...args) => handlers[channel](...args))
  }
  on('snapshot', () => ({ state: store.state, tabs: tabs.runtime(), mode, hasPage: !!tabs.activeView }) satisfies Snapshot)
  on('open-item', (id: ItemId) => openItem(id))
  on('new-tab', (input: string, opts?: { incognito?: boolean }) => newTab(input, store.activeWorkspace, true, !!opts?.incognito))
  on('navigate', (input: string, force = false) => {
    const id = activeItemId()
    if (id) tabs.navigate(id, normaliseInput(input), force)
    else newTab(input)
  })
  on('nav', (action: 'back' | 'forward' | 'reload') => {
    const wc = tabs.webContents()
    if (!wc) return
    if (action === 'back') wc.navigationHistory.goBack()
    else if (action === 'forward') wc.navigationHistory.goForward()
    else wc.reload()
  })
  on('close-item', (id: ItemId) => closeItem(id))
  on('move', (id: ItemId, target: DropTarget) => store.move(id, target))
  on('rename', (id: ItemId, title: string) => store.update(id, { title }))
  on('new-folder', () => store.createFolder())
  on('switch-workspace', (id: string) => switchWorkspace(id))
  on('cycle-workspace', (delta: number) => cycleWorkspace(delta))
  on('new-workspace', () => newWorkspace())
  on('update-workspace', (id: string, patch: Partial<Workspace>) => {
    const ws = store.workspace(id)
    if (ws) Object.assign(ws, { name: patch.name ?? ws.name, emoji: patch.emoji ?? ws.emoji, color: patch.color ?? ws.color })
    store.changed()
  })
  on('workspace-menu', (id: string) => workspaceMenu(id))
  on('delete-workspace', (id: string) => deleteWorkspace(id))
  on('item-menu', (id: ItemId) => itemMenu(id))
  on('set-mode', (next: ChromeMode) => setMode(next))
  on('palette', (open: boolean) => (open ? setMode('full') : applyCompact()))
  on('toggle-compact', () => toggleCompact())
  on('tidy', () => tidyToday())
  on('clear', () => clearToday())
  on('suggest', (q: string) => suggest(q))
  on('copy-url', () => clipboard.writeText(tabs.webContents()?.getURL() ?? ''))
  on('restore-archived', (index: number) => restoreArchived(index))
  on('focus-page', () => tabs.webContents()?.focus())
  on('find', (text: string, forward: boolean, findNext: boolean) => {
    const wc = tabs.webContents()
    if (!wc) return
    if (text) wc.findInPage(text, { forward, findNext })
    else wc.stopFindInPage('clearSelection')
  })
  on('find-close', () => closeFind())
  on('open-find', () => openFind())
  on('open-by-name', (query: string) => openByName(query))
  on('ui-state', (state: typeof ui) => {
    ui = state
  })
}

function animateReveal(to: number, done?: () => void): void {
  if (revealTimer) clearInterval(revealTimer)
  const from = reveal
  const start = Date.now()
  revealTimer = setInterval(() => {
    const t = Math.min(1, (Date.now() - start) / REVEAL_MS)
    const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
    reveal = from + (to - from) * eased
    layout()
    if (t === 1) {
      clearInterval(revealTimer!)
      revealTimer = null
      done?.()
    }
  }, 1000 / 60)
}

/**
 * Opens a sidebar item by (part of) its title or URL: Essentials and pinned of
 * the active workspace first, then its Today tabs, then other workspaces.
 */
function openByName(query: string): string {
  const q = query.toLowerCase().trim()
  if (!q) throw new Error('Provide a tab name')
  const s = store.state
  const flatten = (ids: ItemId[]): ItemId[] =>
    ids.flatMap((id) => (s.items[id]?.kind === 'folder' ? flatten(s.items[id].children ?? []) : [id]))
  const score = (id: ItemId): number => {
    const it = s.items[id]
    if (!it || it.kind !== 'tab') return 0
    const title = (tabs.runtime()[id]?.title || it.title).toLowerCase()
    const url = (it.url ?? '').toLowerCase()
    return title === q ? 4 : title.startsWith(q) ? 3 : title.includes(q) ? 2 : url.includes(q) ? 1 : 0
  }
  const ordered = [store.activeWorkspace, ...s.workspaces.filter((w) => w !== store.activeWorkspace)]
  for (const ws of ordered) {
    const candidates = [...flatten(s.essentials[ws.profileId] ?? []), ...flatten(ws.pinned), ...ws.today]
    const best = candidates.map((id) => ({ id, sc: score(id) })).filter((c) => c.sc).sort((a, b) => b.sc - a.sc)[0]
    if (best) {
      if (ws.id !== store.activeWorkspace.id) switchWorkspace(ws.id)
      openItem(best.id)
      return `opened "${s.items[best.id].title}"${ws.id !== ordered[0].id ? ` in workspace ${ws.name}` : ''}`
    }
  }
  throw new Error(`No tab matching "${query}"`)
}

function toggleCompact(): void {
  const compact = !store.state.settings.compact
  store.state.settings.compact = compact
  store.changed()
  if (compact) {
    // Slide the docked sidebar away first, then switch to the edge hot-zone
    setMode('docked')
    animateReveal(0, () => store.state.settings.compact && setMode('edge'))
  } else {
    setMode('docked')
    animateReveal(1)
  }
}

function restoreArchived(index = 0): void {
  const entry = store.state.archive.splice(index, 1)[0]
  if (!entry) return
  const ws = store.workspace(entry.workspaceId) ?? store.activeWorkspace
  if (ws.id !== store.activeWorkspace.id) switchWorkspace(ws.id)
  const item = store.createTab(entry.url, entry.title, ws)
  store.update(item.id, { favicon: entry.favicon })
  openItem(item.id)
}

// ---------- window ----------

function createWindow(): void {
  win = new BaseWindow({
    width: 1440,
    height: 900,
    minWidth: 600,
    minHeight: 400,
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 14, y: 14 },
    backgroundColor: store.activeWorkspace.color,
    show: false
  })
  // No page of its own: the uncovered frame around the tab stays natively draggable

  chrome = new WebContentsView({
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false, contextIsolation: true }
  })
  chrome.setBackgroundColor('#00000000')
  win.contentView.addChildView(chrome)

  tabs = new TabManager(win, store, {
    onChange: push,
    layout,
    openInNewTab: (url, background) => newTab(url, store.activeWorkspace, !background),
    openIncognito: (url) => newTab(url, store.activeWorkspace, true, true),
    htmlFullscreen: (on) => {
      htmlFullscreen = on
      if (on && !win.isFullScreen()) {
        fullscreenedForPage = true
        win.setFullScreen(true)
      } else if (!on && fullscreenedForPage) {
        fullscreenedForPage = false
        win.setFullScreen(false)
      }
      layout()
    },
    onFound: (result) => {
      findView?.webContents.send('found', { active: result.activeMatchOrdinal, total: result.matches })
    }
  })

  captureConsole(chrome.webContents, 'sidebar')
  loadRenderer(chrome)

  chrome.webContents.once('did-finish-load', () => {
    win.show()
    const active = activeItemId()
    if (active) tabs.show(active)
    push()
  })

  win.on('resize', layout)
  win.on('enter-full-screen', layout)
  win.on('leave-full-screen', layout)
  win.on('focus', () => tabs.webContents()?.focus())

  store.onChange(push)
  reveal = store.state.settings.compact ? 0 : 1
  applyCompact()
  layout()

  Menu.setApplicationMenu(
    buildMenu({
      newTab: () => chrome.webContents.send('command', { type: 'palette', mode: 'new' }),
      editUrl: () => chrome.webContents.send('command', { type: 'palette', mode: 'edit' }),
      closeTab: () => {
        const id = activeItemId()
        if (id) closeItem(id)
      },
      reopen: () => restoreArchived(0),
      toggleSidebar: toggleCompact,
      togglePin: () => {
        const id = activeItemId()
        if (id) togglePin(id)
      },
      copyUrl: () => clipboard.writeText(tabs.webContents()?.getURL() ?? ''),
      reload: () => tabs.webContents()?.reload(),
      hardReload: () => tabs.webContents()?.reloadIgnoringCache(),
      back: () => tabs.webContents()?.navigationHistory.goBack(),
      forward: () => tabs.webContents()?.navigationHistory.goForward(),
      zoom: (delta) => {
        const wc = tabs.webContents()
        if (wc) wc.setZoomLevel(delta === 0 ? 0 : wc.getZoomLevel() + delta * 0.5)
      },
      workspace: (n) => {
        const ws = store.state.workspaces[n]
        if (ws) switchWorkspace(ws.id)
      },
      cycleWorkspace,
      devtoolsPage: () => tabs.webContents()?.toggleDevTools(),
      devtoolsChrome: () => chrome.webContents.toggleDevTools(),
      find: openFind,
      findNext: () => findStep(true),
      findPrev: () => findStep(false),
      importPasswords: async () => {
        const pick = await dialog.showOpenDialog(win, {
          title: 'Import passwords',
          message: 'Choose the CSV exported from the Passwords app (File → Export All Passwords…)',
          defaultPath: app.getPath('downloads'),
          filters: [{ name: 'CSV', extensions: ['csv'] }],
          properties: ['openFile']
        })
        const file = pick.filePaths[0]
        if (!file) return
        try {
          const r = importCsv(file)
          const choice = await dialog.showMessageBox(win, {
            type: 'info',
            message: `Imported passwords: ${r.added} new, ${r.updated} updated${r.skipped ? `, ${r.skipped} skipped (no address)` : ''}. Drift now has ${passwordCount()}.`,
            detail: 'The exported file holds every password in plain text. Move it to the Trash now?',
            buttons: ['Move to Trash', 'Keep file'],
            defaultId: 0,
            cancelId: 1
          })
          if (choice.response === 0) await shell.trashItem(file)
        } catch (e) {
          dialog.showErrorBox('Import failed', (e as Error).message)
        }
      },
      fillLogin: () => {
        const wc = tabs.webContents()
        if (wc && fillLoginInteractive(wc, win) === 'none')
          dialog.showMessageBox(win, { type: 'info', message: 'No saved password for this site.' })
      },
      setDefaultBrowser: () => {
        app.setAsDefaultProtocolClient('http')
        app.setAsDefaultProtocolClient('https')
      },
      newFolder: () => store.createFolder(),
      newIncognito: () => chrome.webContents.send('command', { type: 'palette', mode: 'incognito' }),
      tabAt: selectTabAt,
      cycleTab,
      duplicateTab,
      stop: () => tabs.webContents()?.stop(),
      print: () => tabs.webContents()?.print(),
      viewSource: () => {
        const url = tabs.webContents()?.getURL()
        if (url && /^https?:/.test(url)) newTab(`view-source:${url}`)
      },
      newWorkspace
    })
  )
}

/** Flat status for wait conditions and before/after diffs; page data limited to url/title */
function controlStatus(): Status {
  const ws = store.activeWorkspace
  const active = activeItemId()
  const rt = active ? tabs.runtime()[active] : undefined
  return {
    mode,
    compact: store.state.settings.compact,
    animating: revealTimer !== null || !!ui.animating,
    workspace: ws.name,
    tab: active ? (store.state.items[active]?.title ?? null) : null,
    url: rt?.url ?? (active ? (store.state.items[active]?.url ?? null) : null),
    title: rt?.title ?? null,
    loading: rt?.loading ?? false,
    loadedTabs: Object.values(tabs.runtime()).filter((t) => !t.sleeping).length,
    findOpen: !!findView,
    htmlFullscreen,
    ...ui
  }
}

/** Compact, favicon-free view of the state for the control channel */
function controlSummary(): unknown {
  const s = store.state
  const ws = store.activeWorkspace
  const rt = tabs.runtime()
  const line = (id: ItemId, depth = 0): string[] => {
    const it = s.items[id]
    if (!it) return []
    const pad = '  '.repeat(depth)
    if (it.kind === 'folder')
      return [`${pad}📁 ${it.title} [${id}]${it.collapsed ? ' (collapsed)' : ''}`, ...(it.children ?? []).flatMap((c) => line(c, depth + 1))]
    const live = rt[id] ? (rt[id].sleeping ? ' 💤' : ' ●') : ''
    return [`${pad}${it.title} — ${it.url} [${id}]${live}`]
  }
  const active = activeItemId()
  return {
    mode,
    compact: s.settings.compact,
    workspace: `${ws.emoji ?? ''} ${ws.name} [${ws.id}] profile=${ws.profileId}`,
    workspaces: s.workspaces.map((w) => `${w.emoji ?? ''} ${w.name} [${w.id}]`),
    activeTab: active ? { id: active, title: rt[active]?.title ?? s.items[active]?.title, url: rt[active]?.url } : null,
    findOpen: !!findView,
    essentials: (s.essentials[ws.profileId] ?? []).flatMap((id) => line(id)),
    pinned: ws.pinned.flatMap((id) => line(id)),
    today: ws.today.flatMap((id) => line(id)),
    loadedTabs: Object.values(rt).filter((t) => !t.sleeping).length
  }
}

// ---------- startup ----------

async function runArcImport(): Promise<void> {
  const log = (m: string): void => console.log(m)
  log('Importing from Arc…')
  const { state, profiles } = importSidebar()
  // Arc's own timestamps would archive every Today tab at once
  for (const ws of state.workspaces) for (const id of ws.today) state.items[id].lastActiveAt = Date.now()
  log(`  • ${state.workspaces.length} workspaces, ${Object.keys(state.items).length} items, ${profiles.length} profiles`)
  copyStorage(profiles, log)
  const history = importHistory(profiles)
  log(`  • history: ${history.length} addresses`)
  store.replaceState(state, history)
  saveStateNow(store.state)
  log('Sidebar imported, importing sessions in the background…')
  // Cookies go last and don't block startup: the Keychain prompt may take a while
  importCookies(profiles, log)
    .then(() => {
      log('Done.')
      // Pages opened before cookies landed need a reload to pick up logins
      for (const id of Object.keys(tabs.runtime())) tabs.webContents(id)?.reload()
    })
    .catch((err) => log(`  ! cookies skipped: ${(err as Error).message}`))
}

// Links from other apps (when Drift is the default browser) can arrive before the window exists
const pendingUrls: string[] = []
let ready = false
app.on('open-url', (e, url) => {
  e.preventDefault()
  if (ready) newTab(url)
  else pendingUrls.push(url)
})
app.on('open-file', (e, path) => {
  e.preventDefault()
  const url = `file://${path}`
  if (ready) newTab(url)
  else pendingUrls.push(url)
})

app.whenReady().then(async () => {
  if (!(await acquireInstanceLock())) {
    app.quit()
    return
  }
  // Dev runs from the stock Electron binary; show Drift's icon in the Dock anyway
  if (!app.isPackaged) app.dock?.setIcon(join(__dirname, '../../resources/icon.png'))
  store = new Store()
  const firstRun = !existsSync(statePath())
  if (process.argv.includes('--import-arc') || (firstRun && arcAvailable())) {
    await runArcImport()
  }
  registerIpc()
  createWindow()
  if (!app.isPackaged || process.argv.includes('--control')) {
    // Tab views: errors only (never regular page console output)
    app.on('web-contents-created', (_e, wc) => {
      setImmediate(() => {
        if (wc !== chrome.webContents && wc !== findView?.webContents) capturePageErrors(wc)
      })
    })
    startControl({
      target: (name) =>
        name === 'page' ? tabs.webContents() : name === 'find' ? (findView?.webContents ?? null) : chrome.webContents,
      actions: handlers,
      summary: controlSummary,
      status: controlStatus,
      seq: () => seq,
      guardUnload: (on: boolean) => {
        tabs.quietUnload = on
      },
      unloadBlockedSince: (t: number) => (tabs.lastUnloadBlock?.at ?? 0) >= t,
      revealSidebar: async () => {
        chrome.webContents.send('command', { type: 'peek' })
        const until = Date.now() + 1500
        while (Date.now() < until && !(ui.peekOpen && !ui.animating && mode === 'peek')) await new Promise((r) => setTimeout(r, 30))
      }
    })
  }
  chrome.webContents.once('did-finish-load', () => {
    ready = true
    for (const url of pendingUrls.splice(0)) newTab(url)
  })
  setInterval(archiveStale, 10 * 60_000)
})

app.on('before-quit', () => store?.flush())
app.on('window-all-closed', () => app.quit())
app.on('activate', () => win?.show())
