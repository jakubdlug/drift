# Drift

Lekka przeglądarka w stylu Arc na Electronie (Chromium). Vertical tabs z auto-ukrywaniem, workspace'y z izolowanymi sesjami, Essentials, pinned z folderami, archiwum i usypianie kart.

## Start

```bash
npm install
npm run dev          # tryb deweloperski z hot reloadem sidebara
npm run import:arc   # ponowny import z Arca (nadpisuje stan Drifta)
npm run dist         # Drift.app w dist/
```

Pierwsze uruchomienie importuje dane z Arca automatycznie, jeśli Arc jest zainstalowany.

## Co jest importowane z Arca

- Space'y → workspace'y (nazwa, emoji, kolor), profile → osobne sesje (`persist:arc-*`)
- Essentials (per profil), pinned z folderami, karty Today, favicony
- Historia (do podpowiedzi w ⌘T)
- Sesje: ciasteczka (odszyfrowane kluczem „Arc Safe Storage”), Local Storage, IndexedDB

Nie są importowane: hasła, rozszerzenia, Boosts, Easels.

## Skróty

| Skrót | Akcja |
|---|---|
| ⌘T / ⌘L | Nowa karta / edycja adresu (paleta z podpowiedziami) |
| ⌘W / ⌘⇧T | Zamknij kartę (Today → archiwum) / przywróć |
| ⌘S | Pokaż/ukryj sidebar (w trybie ukrytym wysuwa się przy lewej krawędzi) |
| ⌘D | Przypnij / odepnij |
| ⌘⇧C | Kopiuj URL |
| Ctrl+1…9, ⌘⌥←/→, swipe dwoma palcami | Przełączanie workspace'ów |
| ⌘[ / ⌘] / ⌘R | Wstecz / dalej / odśwież |

## Architektura

- `src/main/store.ts` — stan sidebara (jedno źródło prawdy), zapis do `~/Library/Application Support/Drift/state.json`
- `src/main/tabs.ts` — `WebContentsView` na kartę, usypianie po `sleepAfterMin` minutach
- `src/main/index.ts` — okno (`BaseWindow`), layout, IPC, archiwizacja Today po `archiveAfterHours`
- `src/main/arc-import.ts` — import z Arca
- `src/renderer` — sidebar w Svelte 5, rysowany w osobnym przezroczystym `WebContentsView` nad stroną
