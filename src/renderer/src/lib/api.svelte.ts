import type { DropTarget, Item, ItemId, RuntimeTab, Snapshot, Workspace } from '@shared/types'

export const app = $state<{ snap: Snapshot | null }>({ snap: null })

export const call = (channel: string, ...args: unknown[]): Promise<unknown> => window.drift.invoke(channel, ...args)

export const actions = {
  open: (id: ItemId) => call('open-item', id),
  close: (id: ItemId) => call('close-item', id),
  move: (id: ItemId, target: DropTarget) => call('move', id, $state.snapshot(target)),
  rename: (id: ItemId, title: string) => call('rename', id, title),
  itemMenu: (id: ItemId) => call('item-menu', id),
  newTab: (input: string) => call('new-tab', input),
  navigate: (input: string) => call('navigate', input),
  nav: (action: 'back' | 'forward' | 'reload') => call('nav', action),
  switchWorkspace: (id: string) => call('switch-workspace', id),
  cycleWorkspace: (delta: number) => call('cycle-workspace', delta),
  workspaceMenu: (id: string) => call('workspace-menu', id),
  updateWorkspace: (id: string, patch: Partial<Workspace>) => call('update-workspace', id, patch),
  newWorkspace: () => call('new-workspace'),
  setMode: (mode: Snapshot['mode']) => call('set-mode', mode),
  palette: (open: boolean) => call('palette', open),
  toggleCompact: () => call('toggle-compact'),
  tidy: () => call('tidy'),
  clear: () => call('clear'),
  copyUrl: () => call('copy-url'),
  restoreArchived: (i: number) => call('restore-archived', i),
  focusPage: () => call('focus-page'),
  suggest: (q: string) =>
    call('suggest', q) as Promise<Array<{ kind: 'tab' | 'history'; id?: ItemId; url: string; title: string; favicon?: string }>>
}

export function workspace(snap: Snapshot): Workspace {
  return snap.state.workspaces.find((w) => w.id === snap.state.activeWorkspaceId) ?? snap.state.workspaces[0]
}

export function activeId(snap: Snapshot): ItemId | null {
  return snap.state.activeItemByWorkspace[snap.state.activeWorkspaceId] ?? null
}

export function hostOf(url?: string): string {
  if (!url) return ''
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/** Title shown in the sidebar: saved items keep their name, today tabs follow the page */
export function displayTitle(item: Item, rt: RuntimeTab | undefined, today: boolean): string {
  if (today && rt?.title) return rt.title
  return item.title || rt?.title || hostOf(item.url)
}

export function faviconOf(item: Item, rt?: RuntimeTab): string | undefined {
  return rt?.favicon || item.favicon || (item.url ? `https://www.google.com/s2/favicons?domain=${hostOf(item.url)}&sz=64` : undefined)
}

/** Picks readable text colours for an arbitrary workspace tint */
export function themeVars(hex: string): string {
  const n = parseInt(hex.replace('#', ''), 16)
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  const light = (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6
  const fg = light ? '20, 20, 22' : '240, 240, 242'
  return `--ws:${hex};--fg:rgb(${fg});--fg-rgb:${fg};`
}

export const drag = $state<{ id: ItemId | null }>({ id: null })

/** Sidebar-local UI state, mirrored to main for the control channel (status / wait / diffs) */
export const ui = $state({
  peekOpen: false,
  animating: false,
  palette: null as 'new' | 'edit' | null,
  paletteQuery: '',
  renaming: null as string | null,
  editingWorkspace: null as string | null,
  focus: 'body',
  dragging: false
})

function describeFocus(el: Element | null): string {
  if (!el || el === document.body) return 'body'
  const label = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || (el as HTMLElement).innerText || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
  return `${el.tagName.toLowerCase()}${label ? ` "${label}"` : ''}`
}

document.addEventListener('focusin', () => (ui.focus = describeFocus(document.activeElement)))
document.addEventListener('focusout', () => setTimeout(() => (ui.focus = describeFocus(document.activeElement))))

$effect.root(() => {
  $effect(() => {
    ui.dragging = drag.id !== null
    call('ui-state', $state.snapshot(ui))
  })
})
