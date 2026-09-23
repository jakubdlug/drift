export type ItemId = string

/** Profile = isolated session (cookies, storage). Several workspaces may share one. */
export interface Profile {
  id: string
  name: string
  partition: string
}

export interface Workspace {
  id: string
  name: string
  emoji?: string
  /** Base sidebar tint, hex */
  color: string
  profileId: string
  /** Root-level pinned items (tabs and folders) */
  pinned: ItemId[]
  /** Unpinned "today" tabs, newest first */
  today: ItemId[]
}

export interface Item {
  id: ItemId
  kind: 'tab' | 'folder'
  title: string
  /** For pinned tabs and essentials this is the saved URL; for today tabs the current one */
  url?: string
  favicon?: string
  children?: ItemId[]
  collapsed?: boolean
  createdAt: number
  lastActiveAt?: number
}

export interface ArchivedTab {
  url: string
  title: string
  favicon?: string
  workspaceId: string
  archivedAt: number
}

export interface Settings {
  compact: boolean
  sidebarWidth: number
  /** Inactive tabs are unloaded from memory after this many minutes */
  sleepAfterMin: number
  /** Today tabs untouched for this long go to the archive */
  archiveAfterHours: number
  searchUrl: string
}

export interface State {
  version: 1
  profiles: Profile[]
  workspaces: Workspace[]
  /** Essentials are per profile, like in Arc */
  essentials: Record<string, ItemId[]>
  items: Record<ItemId, Item>
  activeWorkspaceId: string
  activeItemByWorkspace: Record<string, ItemId | null>
  archive: ArchivedTab[]
  settings: Settings
}

/** Live, non-persisted state of a loaded tab */
export interface RuntimeTab {
  id: ItemId
  url: string
  title: string
  favicon?: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  audible: boolean
  sleeping: boolean
  /** Title starts with an unread counter like "(3) Inbox" */
  badge: boolean
}

export interface HistoryEntry {
  url: string
  title: string
  visits: number
  lastVisit: number
}

export type Zone = 'essentials' | 'pinned' | 'today' | 'folder'

export interface DropTarget {
  zone: Zone
  /** Folder id when zone === 'folder' */
  parentId?: ItemId
  index: number
}

/** How much of the window the sidebar view covers */
export type ChromeMode = 'docked' | 'edge' | 'peek' | 'full'

export interface Snapshot {
  state: State
  tabs: Record<ItemId, RuntimeTab>
  mode: ChromeMode
  /** A tab is attached and visible; false = empty workspace, render an empty state */
  hasPage: boolean
}
