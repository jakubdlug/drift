import { Menu, type MenuItemConstructorOptions } from 'electron'

export interface MenuActions {
  newTab: () => void
  editUrl: () => void
  closeTab: () => void
  reopen: () => void
  toggleSidebar: () => void
  togglePin: () => void
  copyUrl: () => void
  reload: () => void
  hardReload: () => void
  back: () => void
  forward: () => void
  zoom: (delta: -1 | 0 | 1) => void
  workspace: (index: number) => void
  cycleWorkspace: (delta: number) => void
  devtoolsPage: () => void
  devtoolsChrome: () => void
  newFolder: () => void
  newWorkspace: () => void
  newIncognito: () => void
  tabAt: (index: number) => void
  cycleTab: (delta: number) => void
  duplicateTab: () => void
  stop: () => void
  print: () => void
  viewSource: () => void
  find: () => void
  findNext: () => void
  findPrev: () => void
  setDefaultBrowser: () => void
}

export function buildMenu(a: MenuActions): Menu {
  const workspaces: MenuItemConstructorOptions[] = Array.from({ length: 9 }, (_, i) => ({
    label: `Workspace ${i + 1}`,
    accelerator: `Ctrl+${i + 1}`,
    click: () => a.workspace(i)
  }))

  return Menu.buildFromTemplate([
    {
      role: 'appMenu',
      submenu: [
        { role: 'about' },
        { label: 'Set as default browser', click: a.setDefaultBrowser },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'File',
      submenu: [
        { label: 'New tab', accelerator: 'Cmd+T', click: a.newTab },
        { label: 'New incognito tab', accelerator: 'Cmd+Shift+N', click: a.newIncognito },
        { label: 'Duplicate tab', accelerator: 'Cmd+Shift+K', click: a.duplicateTab },
        { label: 'New folder', accelerator: 'Cmd+Alt+N', click: a.newFolder },
        { label: 'New workspace', accelerator: 'Cmd+Ctrl+N', click: a.newWorkspace },
        { type: 'separator' },
        { label: 'Close tab', accelerator: 'Cmd+W', click: a.closeTab },
        { label: 'Reopen closed tab', accelerator: 'Cmd+Shift+T', click: a.reopen },
        { type: 'separator' },
        { label: 'Print…', accelerator: 'Cmd+P', click: a.print }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Find on page', accelerator: 'Cmd+F', click: a.find },
        { label: 'Find next', accelerator: 'Cmd+G', click: a.findNext },
        { label: 'Find previous', accelerator: 'Cmd+Shift+G', click: a.findPrev },
        { type: 'separator' },
        { label: 'Copy URL', accelerator: 'Cmd+Shift+C', click: a.copyUrl }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Show/hide sidebar', accelerator: 'Cmd+S', click: a.toggleSidebar },
        { label: 'Edit address', accelerator: 'Cmd+L', click: a.editUrl },
        { type: 'separator' },
        { label: 'Reload', accelerator: 'Cmd+R', click: a.reload },
        { label: 'Reload ignoring cache', accelerator: 'Cmd+Shift+R', click: a.hardReload },
        { label: 'Stop', accelerator: 'Cmd+.', click: a.stop },
        { label: 'View source', accelerator: 'Cmd+Alt+U', click: a.viewSource },
        { type: 'separator' },
        { label: 'Zoom in', accelerator: 'Cmd+=', click: () => a.zoom(1) },
        { label: 'Zoom out', accelerator: 'Cmd+-', click: () => a.zoom(-1) },
        { label: 'Actual size', accelerator: 'Cmd+0', click: () => a.zoom(0) },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { label: 'Page DevTools', accelerator: 'Cmd+Alt+I', click: a.devtoolsPage },
        { label: 'Sidebar DevTools', accelerator: 'Cmd+Alt+Shift+I', click: a.devtoolsChrome }
      ]
    },
    {
      label: 'Tab',
      submenu: [
        { label: 'Back', accelerator: 'Cmd+[', click: a.back },
        { label: 'Forward', accelerator: 'Cmd+]', click: a.forward },
        { label: 'Pin / unpin', accelerator: 'Cmd+D', click: a.togglePin },
        { type: 'separator' },
        { label: 'Next tab', accelerator: 'Ctrl+Tab', click: () => a.cycleTab(1) },
        { label: 'Previous tab', accelerator: 'Ctrl+Shift+Tab', click: () => a.cycleTab(-1) },
        { label: 'Next tab ', accelerator: 'Cmd+Alt+Down', click: () => a.cycleTab(1), visible: false },
        { label: 'Previous tab ', accelerator: 'Cmd+Alt+Up', click: () => a.cycleTab(-1), visible: false },
        { label: 'Next tab  ', accelerator: 'Cmd+Shift+]', click: () => a.cycleTab(1), visible: false },
        { label: 'Previous tab  ', accelerator: 'Cmd+Shift+[', click: () => a.cycleTab(-1), visible: false },
        { type: 'separator' },
        ...Array.from({ length: 8 }, (_, i) => ({ label: `Tab ${i + 1}`, accelerator: `Cmd+${i + 1}`, click: () => a.tabAt(i) })),
        { label: 'Last tab', accelerator: 'Cmd+9', click: () => a.tabAt(-1) }
      ]
    },
    {
      label: 'Workspace',
      submenu: [
        { label: 'Previous', accelerator: 'Cmd+Alt+Left', click: () => a.cycleWorkspace(-1) },
        { label: 'Next', accelerator: 'Cmd+Alt+Right', click: () => a.cycleWorkspace(1) },
        { type: 'separator' },
        ...workspaces
      ]
    },
    { role: 'windowMenu' }
  ])
}
