import { app } from 'electron'
import { randomUUID } from 'crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { DropTarget, HistoryEntry, Item, ItemId, State, Workspace } from '@shared/types'

const ARCHIVE_LIMIT = 1000
const HISTORY_LIMIT = 20000

export const statePath = (): string => join(app.getPath('userData'), 'state.json')
const historyPath = (): string => join(app.getPath('userData'), 'history.json')

export function defaultState(): State {
  const profileId = 'default'
  const ws: Workspace = {
    id: randomUUID(),
    name: 'Home',
    emoji: '🏠',
    color: '#1c1c1f',
    profileId,
    pinned: [],
    today: []
  }
  return {
    version: 1,
    profiles: [{ id: profileId, name: 'Default', partition: 'persist:default' }],
    workspaces: [ws],
    essentials: { [profileId]: [] },
    items: {},
    activeWorkspaceId: ws.id,
    activeItemByWorkspace: {},
    archive: [],
    settings: {
      compact: false,
      sidebarWidth: 264,
      sleepAfterMin: 15,
      archiveAfterHours: 12,
      searchUrl: 'https://www.google.com/search?q=%s'
    }
  }
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch (err) {
    console.error(`Failed to read ${path}:`, err)
    return null
  }
}

function writeJsonAtomic(path: string, data: unknown): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(data))
  renameSync(tmp, path)
}

/** Incognito tabs live only in memory: strip them from everything written to disk */
function persistable(state: State): State {
  const incognito = new Set(Object.values(state.items).filter((i) => i.incognito).map((i) => i.id))
  if (!incognito.size) return state
  const keep = (ids: ItemId[]): ItemId[] => ids.filter((id) => !incognito.has(id))
  return {
    ...state,
    items: Object.fromEntries(Object.entries(state.items).filter(([id]) => !incognito.has(id))),
    workspaces: state.workspaces.map((w) => ({ ...w, today: keep(w.today), pinned: keep(w.pinned) })),
    activeItemByWorkspace: Object.fromEntries(
      Object.entries(state.activeItemByWorkspace).map(([ws, id]) => [ws, id && incognito.has(id) ? null : id])
    )
  }
}

export function saveStateNow(state: State): void {
  writeJsonAtomic(statePath(), persistable(state))
}

/**
 * Single source of truth for the sidebar. All mutations go through here;
 * `onChange` fires after each one so the UI can be refreshed and state persisted.
 */
export class Store {
  state: State
  history: HistoryEntry[]
  private saveTimer: NodeJS.Timeout | null = null
  private historyTimer: NodeJS.Timeout | null = null
  private listeners: Array<() => void> = []

  constructor() {
    const loaded = readJson<State>(statePath())
    this.state = loaded ? { ...defaultState(), ...loaded, settings: { ...defaultState().settings, ...loaded.settings } } : defaultState()
    this.history = readJson<HistoryEntry[]>(historyPath()) ?? []
  }

  onChange(fn: () => void): void {
    this.listeners.push(fn)
  }

  changed(): void {
    for (const fn of this.listeners) fn()
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => this.flush(), 500)
  }

  flush(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = null
    saveStateNow(this.state)
    if (this.historyTimer) {
      clearTimeout(this.historyTimer)
      this.historyTimer = null
      writeJsonAtomic(historyPath(), this.history)
    }
  }

  replaceState(state: State, history?: HistoryEntry[]): void {
    this.state = state
    if (history) {
      this.history = history
      writeJsonAtomic(historyPath(), history)
    }
    this.changed()
  }

  // ---- lookups ----

  get activeWorkspace(): Workspace {
    const s = this.state
    return s.workspaces.find((w) => w.id === s.activeWorkspaceId) ?? s.workspaces[0]
  }

  workspace(id: string): Workspace | undefined {
    return this.state.workspaces.find((w) => w.id === id)
  }

  /** Where an item currently lives: which list holds it */
  locate(id: ItemId): { list: ItemId[]; zone: DropTarget['zone']; workspace?: Workspace; parentId?: ItemId } | null {
    const s = this.state
    for (const w of s.workspaces) {
      if (w.pinned.includes(id)) return { list: w.pinned, zone: 'pinned', workspace: w }
      if (w.today.includes(id)) return { list: w.today, zone: 'today', workspace: w }
    }
    for (const [, list] of Object.entries(s.essentials)) {
      if (list.includes(id)) return { list, zone: 'essentials' }
    }
    for (const item of Object.values(s.items)) {
      if (item.children?.includes(id)) {
        return { list: item.children, zone: 'folder', parentId: item.id, workspace: this.workspaceOfFolder(item.id) }
      }
    }
    return null
  }

  private workspaceOfFolder(folderId: ItemId): Workspace | undefined {
    const loc = this.locate(folderId)
    return loc?.workspace
  }

  /** Profile (session) an item belongs to */
  profileOf(id: ItemId): string {
    const s = this.state
    for (const [profileId, list] of Object.entries(s.essentials)) if (list.includes(id)) return profileId
    return this.locate(id)?.workspace?.profileId ?? this.activeWorkspace.profileId
  }

  isToday(id: ItemId): boolean {
    return this.state.workspaces.some((w) => w.today.includes(id))
  }

  // ---- mutations ----

  createTab(url: string, title = url, workspace = this.activeWorkspace, incognito = false): Item {
    const item: Item = { id: randomUUID(), kind: 'tab', title, url, createdAt: Date.now(), lastActiveAt: Date.now(), ...(incognito ? { incognito: true } : {}) }
    this.state.items[item.id] = item
    workspace.today.unshift(item.id)
    this.changed()
    return item
  }

  createFolder(title = 'New folder', target?: DropTarget): Item {
    const item: Item = { id: randomUUID(), kind: 'folder', title, children: [], createdAt: Date.now() }
    this.state.items[item.id] = item
    this.insert(item.id, target ?? { zone: 'pinned', index: 0 })
    this.changed()
    return item
  }

  /** Removes an item (and a folder's contents) from the tree. Returns removed tab ids. */
  remove(id: ItemId): ItemId[] {
    const item = this.state.items[id]
    if (!item) return []
    const removed: ItemId[] = []
    const walk = (it: Item): void => {
      if (it.kind === 'tab') removed.push(it.id)
      for (const c of it.children ?? []) {
        const child = this.state.items[c]
        if (child) walk(child)
      }
      delete this.state.items[it.id]
    }
    this.detach(id)
    walk(item)
    for (const [ws, active] of Object.entries(this.state.activeItemByWorkspace)) {
      if (active && removed.includes(active)) this.state.activeItemByWorkspace[ws] = null
    }
    this.changed()
    return removed
  }

  archive(id: ItemId): void {
    const item = this.state.items[id]
    // Private tabs leave no trace
    if (item?.incognito) {
      this.remove(id)
      return
    }
    const loc = this.locate(id)
    if (item?.url && loc?.workspace) {
      this.state.archive.unshift({
        url: item.url,
        title: item.title,
        favicon: item.favicon,
        workspaceId: loc.workspace.id,
        archivedAt: Date.now()
      })
      this.state.archive.length = Math.min(this.state.archive.length, ARCHIVE_LIMIT)
    }
    this.remove(id)
  }

  private detach(id: ItemId): void {
    const loc = this.locate(id)
    if (loc) loc.list.splice(loc.list.indexOf(id), 1)
  }

  private listFor(target: DropTarget): ItemId[] | null {
    const s = this.state
    if (target.zone === 'folder') return target.parentId ? (s.items[target.parentId]?.children ?? null) : null
    if (target.zone === 'essentials') return (s.essentials[this.activeWorkspace.profileId] ??= [])
    return this.activeWorkspace[target.zone]
  }

  private insert(id: ItemId, target: DropTarget): void {
    const list = this.listFor(target)
    if (!list) return
    list.splice(Math.max(0, Math.min(target.index, list.length)), 0, id)
  }

  move(id: ItemId, target: DropTarget): void {
    const item = this.state.items[id]
    if (!item) return
    // Incognito tabs stay in Today: pinning would persist them
    if (item.incognito && target.zone !== 'today') return
    // Folders can't go into essentials or into themselves
    if (item.kind === 'folder' && (target.zone === 'essentials' || target.zone === 'today')) return
    if (target.zone === 'folder' && target.parentId && this.isDescendant(target.parentId, id)) return

    const from = this.locate(id)
    const list = this.listFor(target)
    if (!list) return
    let index = target.index
    // Moving down within the same list shifts indices by one
    if (from && from.list === list && from.list.indexOf(id) < index) index--
    this.detach(id)
    this.insert(id, { ...target, index })
    this.changed()
  }

  private isDescendant(candidate: ItemId, ancestor: ItemId): boolean {
    if (candidate === ancestor) return true
    for (const c of this.state.items[ancestor]?.children ?? []) if (this.isDescendant(candidate, c)) return true
    return false
  }

  update(id: ItemId, patch: Partial<Item>): void {
    const item = this.state.items[id]
    if (!item) return
    Object.assign(item, patch)
    this.changed()
  }

  /** Tab that was active before the current one, per workspace (where closing a tab returns to) */
  previousActive: Record<string, ItemId | null> = {}

  setActive(workspaceId: string, id: ItemId | null): void {
    const current = this.state.activeItemByWorkspace[workspaceId] ?? null
    if (current && current !== id) this.previousActive[workspaceId] = current
    this.state.activeItemByWorkspace[workspaceId] = id
    if (id && this.state.items[id]) this.state.items[id].lastActiveAt = Date.now()
    this.changed()
  }

  recordVisit(url: string, title: string, incognito = false): void {
    if (incognito || !/^https?:/.test(url)) return
    const now = Date.now()
    const existing = this.history.find((h) => h.url === url)
    if (existing) {
      existing.visits++
      existing.lastVisit = now
      existing.title = title || existing.title
    } else {
      this.history.push({ url, title, visits: 1, lastVisit: now })
      if (this.history.length > HISTORY_LIMIT) {
        this.history.sort((a, b) => b.lastVisit - a.lastVisit)
        this.history.length = HISTORY_LIMIT
      }
    }
    if (!this.historyTimer) {
      this.historyTimer = setTimeout(() => {
        this.historyTimer = null
        writeJsonAtomic(historyPath(), this.history)
      }, 5000)
    }
  }
}
