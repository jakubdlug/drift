import { app, BaseWindow, dialog, WebContentsView, session, shell, type Session } from 'electron'
import { existsSync } from 'fs'
import { join, parse } from 'path'
import { showPageMenu } from './page-menu'
import type { ItemId, RuntimeTab } from '@shared/types'
import type { Store } from './store'

interface LiveTab {
  view: WebContentsView | null
  info: RuntimeTab
}

/**
 * Identify as Google Chrome in User-Agent Client Hints too (Sec-CH-UA / navigator.userAgentData).
 * Some sites (banks) silently refuse to render for an unknown "Chromium"-only brand list.
 */
function presentAsChrome(wc: Electron.WebContents): void {
  const major = process.versions.chrome.split('.')[0]
  const full = process.versions.chrome
  const ua = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`
  const brands = [
    { brand: 'Google Chrome', version: major },
    { brand: 'Chromium', version: major },
    { brand: 'Not?A_Brand', version: '24' }
  ]
  try {
    // No detach on 'destroyed': the debugger goes away with its webContents, and touching it then throws
    wc.debugger.attach('1.3')
    wc.debugger
      .sendCommand('Emulation.setUserAgentOverride', {
        userAgent: ua,
        userAgentMetadata: {
          brands,
          fullVersionList: brands.map((b) => ({ ...b, version: b.brand === 'Not?A_Brand' ? '24.0.0.0' : full })),
          fullVersion: full,
          platform: 'macOS',
          platformVersion: '15.0.0',
          architecture: process.arch === 'arm64' ? 'arm' : 'x86',
          bitness: '64',
          model: '',
          mobile: false
        }
      })
      .catch(() => {})
  } catch {
    // Debugger already attached (DevTools protocol client): keep the default identity
  }
}

const BADGE_RE = /\(\d[\d\s.,]*\+?\)|^\*/

/**
 * Owns the WebContentsView of every loaded tab. A tab is keyed by the sidebar
 * item id; sleeping tabs keep their runtime info but release the renderer.
 */
export class TabManager {
  private tabs = new Map<ItemId, LiveTab>()
  private attached: ItemId | null = null
  private sessions = new Set<Session>()
  private emitTimer: NodeJS.Timeout | null = null
  /** Tabs whose next beforeunload prompt is skipped (forced navigation) */
  private forceUnload = new Set<ItemId>()
  /** Automation in progress: never pop a blocking dialog, just record the refusal */
  quietUnload = false
  lastUnloadBlock: { id: ItemId; at: number } | null = null

  constructor(
    private win: BaseWindow,
    private store: Store,
    private hooks: {
      onChange: () => void
      layout: () => void
      openInNewTab: (url: string, background: boolean) => void
      htmlFullscreen: (on: boolean) => void
      openIncognito: (url: string) => void
      onFound: (result: Electron.Result) => void
    }
  ) {
    setInterval(() => this.sleepIdle(), 60_000)
  }

  runtime(): Record<ItemId, RuntimeTab> {
    const out: Record<ItemId, RuntimeTab> = {}
    for (const [id, t] of this.tabs) out[id] = t.info
    return out
  }

  get activeView(): WebContentsView | null {
    const view = this.attached ? (this.tabs.get(this.attached)?.view ?? null) : null
    return view && !view.webContents.isDestroyed() ? view : null
  }

  get activeId(): ItemId | null {
    return this.attached
  }

  /** One in-memory session shared by all incognito tabs (like a Chrome incognito window) */
  private incognitoSession(): Session {
    const ses = session.fromPartition('drift-incognito')
    if (!this.sessions.has(ses)) {
      this.sessions.add(ses)
      ses.setUserAgent(ses.getUserAgent().replace(/\s?Electron\/\S+/, '').replace(/\s?drift\/\S+/i, ''))
      ses.setSpellCheckerLanguages(['pl', 'en-US'])
    }
    return ses
  }

  /** Wipes the incognito session once its last tab is gone */
  private clearIncognitoIfUnused(): void {
    const anyLeft = [...this.tabs.keys()].some((id) => this.store.state.items[id]?.incognito)
    if (anyLeft) return
    const ses = session.fromPartition('drift-incognito')
    ses.clearStorageData().catch(() => {})
    ses.clearCache().catch(() => {})
  }

  private sessionFor(profileId: string): Session {
    const profile = this.store.state.profiles.find((p) => p.id === profileId) ?? this.store.state.profiles[0]
    const ses = session.fromPartition(profile.partition)
    if (!this.sessions.has(ses)) {
      this.sessions.add(ses)
      // Drop the "Electron/x" token so sites treat us like regular Chrome
      ses.setUserAgent(ses.getUserAgent().replace(/\s?Electron\/\S+/, '').replace(/\s?drift\/\S+/i, ''))
      ses.setPermissionRequestHandler((_wc, permission, cb) => {
        cb(['clipboard-read', 'clipboard-sanitized-write', 'notifications', 'fullscreen', 'media', 'pointerLock'].includes(permission))
      })
      ses.setSpellCheckerLanguages(['pl', 'en-US'])
      ses.on('will-download', (_e, item) => {
        // Straight to ~/Downloads without a dialog, never overwriting
        const dir = app.getPath('downloads')
        const { name, ext } = parse(item.getFilename())
        let target = join(dir, `${name}${ext}`)
        for (let i = 1; existsSync(target); i++) target = join(dir, `${name} (${i})${ext}`)
        item.setSavePath(target)
        item.once('done', (_ev, state) => {
          if (state === 'completed') app.dock?.downloadFinished(target)
        })
      })
    }
    return ses
  }

  private emit(): void {
    if (this.emitTimer) return
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null
      this.hooks.onChange()
    }, 16)
  }

  private createView(id: ItemId, url: string): WebContentsView {
    const view = new WebContentsView({
      webPreferences: {
        session: this.store.state.items[id]?.incognito ? this.incognitoSession() : this.sessionFor(this.store.profileOf(id)),
        sandbox: true,
        contextIsolation: true,
        scrollBounce: true
      }
    })
    view.setBorderRadius(8)
    view.setBackgroundColor('#ffffff')
    const wc = view.webContents
    const tab = this.tabs.get(id)!
    presentAsChrome(wc)

    const sync = (): void => {
      if (wc.isDestroyed()) return
      tab.info.url = wc.getURL() || tab.info.url
      tab.info.canGoBack = wc.navigationHistory.canGoBack()
      tab.info.canGoForward = wc.navigationHistory.canGoForward()
      this.emit()
    }

    wc.on('did-start-loading', () => {
      tab.info.loading = true
      this.emit()
    })
    wc.on('did-stop-loading', () => {
      tab.info.loading = false
      sync()
    })
    wc.on('did-navigate', (_e, navUrl) => {
      if (wc.isDestroyed()) return
      sync()
      this.store.recordVisit(navUrl, wc.getTitle(), !!this.store.state.items[id]?.incognito)
      // Today tabs follow the page; pinned ones keep their saved URL
      if (this.store.isToday(id)) this.store.update(id, { url: navUrl })
    })
    wc.on('did-navigate-in-page', (_e, navUrl, isMainFrame) => {
      sync()
      // SPA navigation (YouTube, Gmail…) should also move today tabs along
      if (isMainFrame && this.store.isToday(id)) this.store.update(id, { url: navUrl })
    })
    wc.on('page-title-updated', (_e, title) => {
      if (wc.isDestroyed()) return
      tab.info.title = title
      tab.info.badge = BADGE_RE.test(title)
      this.store.recordVisit(wc.getURL(), title, !!this.store.state.items[id]?.incognito)
      if (this.store.isToday(id)) this.store.update(id, { title })
      this.emit()
    })
    wc.on('page-favicon-updated', (_e, favicons) => {
      const icon = favicons[0]
      if (!icon) return
      tab.info.favicon = icon
      const item = this.store.state.items[id]
      if (item && (this.store.isToday(id) || !item.favicon)) this.store.update(id, { favicon: icon })
      this.emit()
    })
    wc.on('context-menu', (_e, params) =>
      showPageMenu(wc, params, {
        win: this.win,
        openTab: (u, background) => this.hooks.openInNewTab(u, background),
        openIncognito: (u) => this.hooks.openIncognito(u),
        searchUrl: this.store.state.settings.searchUrl
      })
    )
    // Pages with unsaved changes (beforeunload): Electron silently cancels by default — ask like Chrome does
    wc.on('will-prevent-unload', (e) => {
      if (this.forceUnload.delete(id)) {
        e.preventDefault()
        return
      }
      if (this.quietUnload) {
        this.lastUnloadBlock = { id, at: Date.now() }
        return
      }
      const choice = dialog.showMessageBoxSync(this.win, {
        type: 'question',
        buttons: ['Stay', 'Leave page'],
        defaultId: 0,
        cancelId: 0,
        message: 'Leave this page?',
        detail: 'Changes you made may not be saved.'
      })
      if (choice === 1) e.preventDefault()
    })
    wc.on('enter-html-full-screen', () => this.hooks.htmlFullscreen(true))
    wc.on('leave-html-full-screen', () => this.hooks.htmlFullscreen(false))
    wc.on('found-in-page', (_e, result) => this.hooks.onFound(result))
    wc.on('audio-state-changed', (e) => {
      tab.info.audible = e.audible
      this.emit()
    })
    wc.on('render-process-gone', () => {
      tab.view = null
      tab.info.sleeping = true
      if (this.attached === id) this.attached = null
      this.emit()
    })

    wc.setWindowOpenHandler(({ url: target, disposition, features }) => {
      // Real popups (OAuth, payment) need window.opener, so they get a window
      if (disposition === 'new-window' || features.includes('width')) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: { width: 520, height: 700, parent: this.win, webPreferences: { session: wc.session } }
        }
      }
      if (/^https?:/.test(target)) this.hooks.openInNewTab(target, disposition === 'background-tab')
      else shell.openExternal(target)
      return { action: 'deny' }
    })

    wc.loadURL(url).catch(() => {})
    return view
  }

  /** Shows a tab, loading or waking it if needed */
  show(id: ItemId, urlOverride?: string): void {
    const item = this.store.state.items[id]
    if (!item || item.kind !== 'tab' || !item.url) return
    let tab = this.tabs.get(id)
    if (!tab) {
      tab = {
        view: null,
        info: {
          id,
          url: item.url,
          title: item.title,
          favicon: item.favicon,
          loading: true,
          canGoBack: false,
          canGoForward: false,
          audible: false,
          sleeping: false,
          badge: false
        }
      }
      this.tabs.set(id, tab)
    }
    if (urlOverride) tab.info.url = urlOverride
    // A view whose renderer is gone can't be shown again: drop it and rebuild
    if (tab.view && tab.view.webContents.isDestroyed()) {
      if (this.attached === id) this.attached = null
      tab.view = null
    }
    if (!tab.view) {
      tab.info.sleeping = false
      tab.view = this.createView(id, tab.info.url || item.url)
    } else if (urlOverride) {
      tab.view.webContents.loadURL(urlOverride).catch(() => {})
    }
    if (this.attached !== id) {
      this.detach()
      this.win.contentView.addChildView(tab.view)
      this.attached = id
    }
    this.hooks.layout()
    tab.view.webContents.focus()
    this.emit()
  }

  /** Removes the visible tab view from the window without unloading it */
  detach(): void {
    const view = this.activeView
    try {
      if (view) this.win.contentView.removeChildView(view)
    } catch {
      // Already destroyed together with its webContents
    }
    this.attached = null
  }

  /** Unloads a tab from memory; its sidebar item stays */
  close(id: ItemId): void {
    const tab = this.tabs.get(id)
    if (!tab) return
    if (this.attached === id) this.detach()
    const wasIncognito = !!this.store.state.items[id]?.incognito
    if (tab.view && !tab.view.webContents.isDestroyed()) tab.view.webContents.close()
    this.tabs.delete(id)
    if (wasIncognito) this.clearIncognitoIfUnused()
    this.emit()
  }

  sleep(id: ItemId): void {
    const tab = this.tabs.get(id)
    if (!tab?.view || this.attached === id) return
    tab.view.webContents.close()
    tab.view = null
    tab.info.sleeping = true
    tab.info.loading = false
    this.emit()
  }

  private sleepIdle(): void {
    const limit = this.store.state.settings.sleepAfterMin * 60_000
    const now = Date.now()
    const visible = new Set(Object.values(this.store.state.activeItemByWorkspace))
    for (const [id, tab] of this.tabs) {
      if (!tab.view || tab.info.audible || id === this.attached) continue
      const last = this.store.state.items[id]?.lastActiveAt ?? 0
      // The last-used tab of other workspaces stays warm for quick switching
      if (visible.has(id) && now - last < limit * 4) continue
      if (now - last > limit) this.sleep(id)
    }
  }

  webContents(id: ItemId | null = this.attached): Electron.WebContents | null {
    return id ? (this.tabs.get(id)?.view?.webContents ?? null) : null
  }

  navigate(id: ItemId, url: string, force = false): void {
    if (force) this.forceUnload.add(id)
    this.show(id, url)
  }

  isLoaded(id: ItemId): boolean {
    return !!this.tabs.get(id)?.view
  }
}
