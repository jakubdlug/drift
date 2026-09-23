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
        { label: 'Ustaw jako domyślną przeglądarkę', click: a.setDefaultBrowser },
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
      label: 'Plik',
      submenu: [
        { label: 'Nowa karta', accelerator: 'Cmd+T', click: a.newTab },
        { label: 'Nowy folder', accelerator: 'Cmd+Shift+N', click: a.newFolder },
        { label: 'Nowy workspace', accelerator: 'Cmd+Ctrl+N', click: a.newWorkspace },
        { type: 'separator' },
        { label: 'Zamknij kartę', accelerator: 'Cmd+W', click: a.closeTab },
        { label: 'Przywróć zamkniętą kartę', accelerator: 'Cmd+Shift+T', click: a.reopen }
      ]
    },
    {
      label: 'Edycja',
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
        { label: 'Znajdź na stronie', accelerator: 'Cmd+F', click: a.find },
        { label: 'Następne wystąpienie', accelerator: 'Cmd+G', click: a.findNext },
        { label: 'Poprzednie wystąpienie', accelerator: 'Cmd+Shift+G', click: a.findPrev },
        { type: 'separator' },
        { label: 'Kopiuj URL', accelerator: 'Cmd+Shift+C', click: a.copyUrl }
      ]
    },
    {
      label: 'Widok',
      submenu: [
        { label: 'Pokaż/ukryj sidebar', accelerator: 'Cmd+S', click: a.toggleSidebar },
        { label: 'Edytuj adres', accelerator: 'Cmd+L', click: a.editUrl },
        { type: 'separator' },
        { label: 'Odśwież', accelerator: 'Cmd+R', click: a.reload },
        { label: 'Odśwież bez cache', accelerator: 'Cmd+Shift+R', click: a.hardReload },
        { type: 'separator' },
        { label: 'Powiększ', accelerator: 'Cmd+=', click: () => a.zoom(1) },
        { label: 'Pomniejsz', accelerator: 'Cmd+-', click: () => a.zoom(-1) },
        { label: 'Rzeczywisty rozmiar', accelerator: 'Cmd+0', click: () => a.zoom(0) },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { label: 'DevTools strony', accelerator: 'Cmd+Alt+I', click: a.devtoolsPage },
        { label: 'DevTools sidebara', accelerator: 'Cmd+Alt+Shift+I', click: a.devtoolsChrome }
      ]
    },
    {
      label: 'Karta',
      submenu: [
        { label: 'Wstecz', accelerator: 'Cmd+[', click: a.back },
        { label: 'Dalej', accelerator: 'Cmd+]', click: a.forward },
        { label: 'Przypnij / odepnij', accelerator: 'Cmd+D', click: a.togglePin }
      ]
    },
    {
      label: 'Workspace',
      submenu: [
        { label: 'Poprzedni', accelerator: 'Cmd+Alt+Left', click: () => a.cycleWorkspace(-1) },
        { label: 'Następny', accelerator: 'Cmd+Alt+Right', click: () => a.cycleWorkspace(1) },
        { type: 'separator' },
        ...workspaces
      ]
    },
    { role: 'windowMenu' }
  ])
}
