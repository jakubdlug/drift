import { app, BaseWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, WebContentsView, webContents } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import type { ChromeMode, DropTarget, ItemId, Snapshot, Workspace } from '@shared/types'
import { arcAvailable, copyStorage, importCookies, importHistory, importSidebar } from './arc-import'
import { buildMenu } from './menu'
import { saveStateNow, statePath, Store } from './store'
import { TabManager } from './tabs'

const GAP = 8
const PEEK_SHADOW = 16

app.setName('Drift')
nativeTheme.themeSource = 'dark'

let win: BaseWindow
let chrome: WebContentsView
let tabs: TabManager
let store: Store
let mode: ChromeMode = 'docked'

// ---------- layout ----------

function layout(): void {
  if (!win || win.isDestroyed()) return
  const [w, h] = win.getContentSize()
  const sw = store.state.settings.sidebarWidth
  const compact = store.state.settings.compact
  const fullscreen = win.isFullScreen()
  const gap = fullscreen && compact ? 0 : GAP

  const chromeBounds = {
    docked: { x: 0, y: 0, width: sw, height: h },
    edge: { x: 0, y: 0, width: GAP, height: h },
    peek: { x: 0, y: 0, width: sw + PEEK_SHADOW, height: h },
    full: { x: 0, y: 0, width: w, height: h }
  }[mode]
  chrome.setBounds(chromeBounds)

  const left = compact ? gap : sw
  tabs.activeView?.setBounds({ x: left, y: gap, width: Math.max(0, w - left - gap), height: Math.max(0, h - gap * 2) })
  tabs.activeView?.setBorderRadius(gap ? 8 : 0)

  // Traffic lights live in the sidebar, so they hide with it
  win.setWindowButtonVisibility(mode !== 'edge')
  // Keep the sidebar above the page
  win.contentView.addChildView(chrome)
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
  if (pushTimer) return
  pushTimer = setTimeout(() => {
    pushTimer = null
    if (chrome.webContents.isDestroyed()) return
    const snapshot: Snapshot = { state: store.state, tabs: tabs.runtime(), mode }
    chrome.webContents.send('snapshot', snapshot)
    win.setBackgroundColor(store.activeWorkspace.color)
  }, 8)
}

// ---------- actions ----------

function normaliseInput(input: string): string {
  const text = input.trim()
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^(about|data|file|chrome):/i.test(text)) return text
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
  store.setActive(store.activeWorkspace.id, id)
  tabs.show(id)
}

function newTab(input: string, workspace: Workspace = store.activeWorkspace, focus = true): ItemId {
  const url = normaliseInput(input)
  const item = store.createTab(url, url, workspace)
  if (focus) openItem(item.id)
  return item.id
}

/** Cmd+W semantics: today tabs are archived, saved ones just unload */
function closeItem(id: ItemId): void {
  const ws = store.activeWorkspace
  const wasActive = store.state.activeItemByWorkspace[ws.id] === id
  let next: ItemId | null = null
  if (wasActive && store.isToday(id)) {
    const i = ws.today.indexOf(id)
    next = ws.today[i + 1] ?? ws.today[i - 1] ?? null
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
  tabs.detach()
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
    { label: 'Zmień nazwę', click: () => chrome.webContents.send('command', { type: 'rename', id }) },
    ...(isTab
      ? [
          { label: 'Kopiuj link', click: () => clipboard.writeText(tabs.runtime()[id]?.url ?? item.url ?? '') },
          ...(loc?.zone !== 'today'
            ? [
                { label: 'Wróć do zapisanego URL', click: () => item.url && tabs.navigate(id, item.url) },
                {
                  label: 'Zapisz bieżący URL jako domyślny',
                  click: () => store.update(id, { url: tabs.runtime()[id]?.url ?? item.url })
                }
              ]
            : []),
          { type: 'separator' as const },
          loc?.zone === 'today'
            ? { label: 'Przypnij', click: () => togglePin(id) }
            : { label: 'Odepnij do Today', click: () => togglePin(id) },
          ...(loc?.zone !== 'essentials'
            ? [{ label: 'Dodaj do Essentials', click: () => store.move(id, { zone: 'essentials', index: 999 }) }]
            : []),
          ...(loaded ? [{ label: 'Uśpij kartę', click: () => tabs.sleep(id) }] : [])
        ]
      : [{ label: 'Nowy podfolder', click: () => store.createFolder('Nowy folder', { zone: 'folder', parentId: id, index: 0 }) }]),
    {
      label: 'Przenieś do workspace',
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
      label: item.kind === 'folder' ? 'Usuń folder z zawartością' : 'Usuń',
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
    { label: 'Zmień nazwę / emoji', click: () => chrome.webContents.send('command', { type: 'edit-workspace', id }) },
    {
      label: 'Profil (sesja)',
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
      label: 'Usuń workspace',
      enabled: store.state.workspaces.length > 1,
      click: async () => {
        const { response } = await dialog.showMessageBox(win, {
          type: 'warning',
          message: `Usunąć workspace „${ws.name}” razem z przypiętymi kartami?`,
          buttons: ['Anuluj', 'Usuń'],
          defaultId: 0
        })
        if (response !== 1) return
        for (const itemId of [...ws.pinned, ...ws.today]) for (const r of store.remove(itemId)) tabs.close(r)
        if (store.state.activeWorkspaceId === ws.id) cycleWorkspace(1)
        store.state.workspaces = store.state.workspaces.filter((w) => w.id !== ws.id)
        store.changed()
      }
    }
  ]).popup({ window: win })
}

function newWorkspace(): void {
  const current = store.activeWorkspace
  const ws: Workspace = {
    id: crypto.randomUUID(),
    name: 'Nowy workspace',
    emoji: '✨',
    color: current.color,
    profileId: current.profileId,
    pinned: [],
    today: []
  }
  store.state.workspaces.push(ws)
  store.changed()
  switchWorkspace(ws.id)
  chrome.webContents.send('command', { type: 'edit-workspace', id: ws.id })
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

function registerIpc(): void {
  const on = (channel: string, fn: (...args: never[]) => unknown): void => {
    ipcMain.handle(channel, (_e, ...args) => (fn as (...a: unknown[]) => unknown)(...args))
  }
  on('snapshot', () => ({ state: store.state, tabs: tabs.runtime(), mode }) satisfies Snapshot)
  on('open-item', (id: ItemId) => openItem(id))
  on('new-tab', (input: string) => newTab(input))
  on('navigate', (input: string) => {
    const id = activeItemId()
    if (id) tabs.navigate(id, normaliseInput(input))
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
}

function toggleCompact(): void {
  store.state.settings.compact = !store.state.settings.compact
  store.changed()
  applyCompact()
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
    openInNewTab: (url) => newTab(url)
  })

  if (process.env.ELECTRON_RENDERER_URL) chrome.webContents.loadURL(process.env.ELECTRON_RENDERER_URL)
  else chrome.webContents.loadFile(join(__dirname, '../renderer/index.html'))

  chrome.webContents.once('did-finish-load', () => {
    win.show()
    // Dev aid: DRIFT_SHOT=/path/prefix writes PNGs of the sidebar and page
    const shot = process.env.DRIFT_SHOT
    if (process.env.DRIFT_EVAL) setTimeout(() => chrome.webContents.executeJavaScript(process.env.DRIFT_EVAL!), 800)
    if (process.env.DRIFT_LOG_TABS) {
      setTimeout(() => {
        for (const t of Object.values(tabs.runtime())) console.log(`TAB ${t.title} | ${t.url}`)
        const byPid = new Map(webContents.getAllWebContents().map((wc) => [wc.getOSProcessId(), wc.getURL().slice(0, 60)]))
        for (const m of app.getAppMetrics())
          console.log(`MEM ${Math.round(m.memory.workingSetSize / 1024)}MB ${m.type} ${byPid.get(m.pid) ?? m.serviceName ?? ''}`)
      }, Number(process.env.DRIFT_SHOT_DELAY ?? 4000))
    }
    if (shot) {
      setTimeout(async () => {
        const { writeFileSync } = await import('fs')
        writeFileSync(`${shot}-sidebar.png`, (await chrome.webContents.capturePage()).toPNG())
        const page = tabs.webContents()
        if (page) writeFileSync(`${shot}-page.png`, (await page.capturePage()).toPNG())
      }, Number(process.env.DRIFT_SHOT_DELAY ?? 4000))
    }
    const active = activeItemId()
    if (active) tabs.show(active)
    push()
  })

  win.on('resize', layout)
  win.on('enter-full-screen', layout)
  win.on('leave-full-screen', layout)
  win.on('focus', () => tabs.webContents()?.focus())

  store.onChange(push)
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
      newFolder: () => store.createFolder(),
      newWorkspace
    })
  )
}

// ---------- startup ----------

async function runArcImport(): Promise<void> {
  const log = (m: string): void => console.log(m)
  log('Import z Arca…')
  const { state, profiles } = importSidebar()
  // Arc's own timestamps would archive every Today tab at once
  for (const ws of state.workspaces) for (const id of ws.today) state.items[id].lastActiveAt = Date.now()
  log(`  • ${state.workspaces.length} workspace'ów, ${Object.keys(state.items).length} elementów, ${profiles.length} profili`)
  copyStorage(profiles, log)
  const history = importHistory(profiles)
  log(`  • historia: ${history.length} adresów`)
  store.replaceState(state, history)
  saveStateNow(store.state)
  log('Sidebar zaimportowany, importuję sesje w tle…')
  // Cookies go last and don't block startup: the Keychain prompt may take a while
  importCookies(profiles, log)
    .then(() => {
      log('Gotowe.')
      // Pages opened before cookies landed need a reload to pick up logins
      for (const id of Object.keys(tabs.runtime())) tabs.webContents(id)?.reload()
    })
    .catch((err) => log(`  ! ciasteczka pominięte: ${(err as Error).message}`))
}

app.whenReady().then(async () => {
  store = new Store()
  const firstRun = !existsSync(statePath())
  if (process.argv.includes('--import-arc') || (firstRun && arcAvailable())) {
    await runArcImport()
  }
  registerIpc()
  createWindow()
  setInterval(archiveStale, 10 * 60_000)
})

app.on('before-quit', () => store?.flush())
app.on('window-all-closed', () => app.quit())
