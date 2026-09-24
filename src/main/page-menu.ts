import { clipboard, Menu, type BaseWindow, type ContextMenuParams, type MenuItemConstructorOptions, type WebContents } from 'electron'

export interface PageMenuDeps {
  win: BaseWindow
  openTab: (url: string, background: boolean) => void
  openIncognito: (url: string) => void
  searchUrl: string
}

/** Native right-click menu for web pages, roughly matching Chrome's */
export function showPageMenu(wc: WebContents, p: ContextMenuParams, deps: PageMenuDeps): void {
  const items: MenuItemConstructorOptions[] = []
  const sep = (): void => {
    if (items.length && items[items.length - 1].type !== 'separator') items.push({ type: 'separator' })
  }

  if (p.misspelledWord) {
    for (const s of p.dictionarySuggestions.slice(0, 5)) items.push({ label: s, click: () => wc.replaceMisspelling(s) })
    if (!p.dictionarySuggestions.length) items.push({ label: 'No suggestions', enabled: false })
    items.push({ label: 'Add to dictionary', click: () => wc.session.addWordToSpellCheckerDictionary(p.misspelledWord) })
    sep()
  }

  if (p.linkURL) {
    items.push(
      { label: 'Open link in new tab', click: () => deps.openTab(p.linkURL, true) },
      { label: 'Open link and switch to tab', click: () => deps.openTab(p.linkURL, false) },
      { label: 'Open link in incognito tab', click: () => deps.openIncognito(p.linkURL) },
      { label: 'Copy link address', click: () => clipboard.writeText(p.linkURL) }
    )
    sep()
  }

  if (p.mediaType === 'image' && p.srcURL) {
    items.push(
      { label: 'Open image in new tab', click: () => deps.openTab(p.srcURL, true) },
      { label: 'Copy image', click: () => wc.copyImageAt(p.x, p.y) },
      { label: 'Copy image address', click: () => clipboard.writeText(p.srcURL) },
      { label: 'Save image', click: () => wc.downloadURL(p.srcURL) }
    )
    sep()
  }

  if (p.isEditable) {
    items.push(
      { role: 'undo', label: 'Undo', enabled: p.editFlags.canUndo },
      { role: 'redo', label: 'Redo', enabled: p.editFlags.canRedo },
      { type: 'separator' },
      { role: 'cut', label: 'Cut', enabled: p.editFlags.canCut },
      { role: 'copy', label: 'Copy', enabled: p.editFlags.canCopy },
      { role: 'paste', label: 'Paste', enabled: p.editFlags.canPaste },
      { role: 'pasteAndMatchStyle', label: 'Paste as plain text', enabled: p.editFlags.canPaste },
      { role: 'selectAll', label: 'Select all' }
    )
    sep()
  } else if (p.selectionText.trim()) {
    const text = p.selectionText.trim()
    const short = text.length > 24 ? `${text.slice(0, 24)}…` : text
    items.push(
      { role: 'copy', label: 'Copy' },
      { label: `Search “${short}”`, click: () => deps.openTab(deps.searchUrl.replace('%s', encodeURIComponent(text)), false) }
    )
    sep()
  }

  if (!p.linkURL && !p.isEditable && !p.selectionText.trim() && p.mediaType === 'none') {
    items.push(
      { label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
      { label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
      { label: 'Reload', click: () => wc.reload() },
      { type: 'separator' },
      { label: 'Copy page address', click: () => clipboard.writeText(wc.getURL()) }
    )
    sep()
  }

  items.push({ label: 'Inspect element', click: () => wc.inspectElement(p.x, p.y) })
  Menu.buildFromTemplate(items).popup({ window: deps.win })
}
