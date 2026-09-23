import { clipboard, Menu, type BaseWindow, type ContextMenuParams, type MenuItemConstructorOptions, type WebContents } from 'electron'

export interface PageMenuDeps {
  win: BaseWindow
  openTab: (url: string, background: boolean) => void
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
    if (!p.dictionarySuggestions.length) items.push({ label: 'Brak podpowiedzi', enabled: false })
    items.push({ label: 'Dodaj do słownika', click: () => wc.session.addWordToSpellCheckerDictionary(p.misspelledWord) })
    sep()
  }

  if (p.linkURL) {
    items.push(
      { label: 'Otwórz link w nowej karcie', click: () => deps.openTab(p.linkURL, true) },
      { label: 'Otwórz link i przejdź do karty', click: () => deps.openTab(p.linkURL, false) },
      { label: 'Kopiuj adres linku', click: () => clipboard.writeText(p.linkURL) }
    )
    sep()
  }

  if (p.mediaType === 'image' && p.srcURL) {
    items.push(
      { label: 'Otwórz obraz w nowej karcie', click: () => deps.openTab(p.srcURL, true) },
      { label: 'Kopiuj obraz', click: () => wc.copyImageAt(p.x, p.y) },
      { label: 'Kopiuj adres obrazu', click: () => clipboard.writeText(p.srcURL) },
      { label: 'Zapisz obraz', click: () => wc.downloadURL(p.srcURL) }
    )
    sep()
  }

  if (p.isEditable) {
    items.push(
      { role: 'undo', label: 'Cofnij', enabled: p.editFlags.canUndo },
      { role: 'redo', label: 'Ponów', enabled: p.editFlags.canRedo },
      { type: 'separator' },
      { role: 'cut', label: 'Wytnij', enabled: p.editFlags.canCut },
      { role: 'copy', label: 'Kopiuj', enabled: p.editFlags.canCopy },
      { role: 'paste', label: 'Wklej', enabled: p.editFlags.canPaste },
      { role: 'pasteAndMatchStyle', label: 'Wklej jako tekst', enabled: p.editFlags.canPaste },
      { role: 'selectAll', label: 'Zaznacz wszystko' }
    )
    sep()
  } else if (p.selectionText.trim()) {
    const text = p.selectionText.trim()
    const short = text.length > 24 ? `${text.slice(0, 24)}…` : text
    items.push(
      { role: 'copy', label: 'Kopiuj' },
      { label: `Szukaj „${short}”`, click: () => deps.openTab(deps.searchUrl.replace('%s', encodeURIComponent(text)), false) }
    )
    sep()
  }

  if (!p.linkURL && !p.isEditable && !p.selectionText.trim() && p.mediaType === 'none') {
    items.push(
      { label: 'Wstecz', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
      { label: 'Dalej', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
      { label: 'Odśwież', click: () => wc.reload() },
      { type: 'separator' },
      { label: 'Kopiuj adres strony', click: () => clipboard.writeText(wc.getURL()) }
    )
    sep()
  }

  items.push({ label: 'Zbadaj element', click: () => wc.inspectElement(p.x, p.y) })
  Menu.buildFromTemplate(items).popup({ window: deps.win })
}
