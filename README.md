# Drift

Lekka przeglądarka w stylu Arc na Electronie (Chromium). Vertical tabs z auto-ukrywaniem, workspace'y z izolowanymi sesjami, Essentials, pinned z folderami, archiwum i usypianie kart.

## Start

```bash
npm install
npm run live         # iteracja na żywo: sidebar HMR, zmiany w main → auto-restart
npm run install-app  # zbuduj i podmień /Applications/Drift.app
npm run dev          # jak live, ale bez auto-restartu procesu głównego
npm run import:arc   # ponowny import z Arca (nadpisuje stan Drifta)
npm run dist         # Drift.app w dist/
```

Pierwsze uruchomienie importuje dane z Arca automatycznie, jeśli Arc jest zainstalowany.

## Iteracja na żywo

`npm run live` zamyka zainstalowany Drift (dane są wspólne, a dwie instancje naraz by je uszkodziły) i startuje wersję dev:

- zmiany w `src/renderer` (Svelte, CSS) są widoczne od razu, bez przeładowania stron,
- zmiany w `src/main` / `src/preload` restartują aplikację; stan się zapisuje, aktywne karty wracają.

Gdy wersja jest dobra: `npm run install-app`.

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

## Sterowanie z zewnątrz (dla agentów i skryptów)

W trybie deweloperskim (albo z flagą `--control`) Drift wystawia kanał sterowania na `127.0.0.1` z losowym tokenem w `~/Library/Application Support/Drift/control.json` (0600).

```bash
scripts/drift-ctl state                 # workspace, aktywna karta, pinned/today
scripts/drift-ctl status                # płaski status: mode, url, peekOpen, palette, focus…
scripts/drift-ctl wait mode=edge animating=false   # czekaj na warunek zamiast sleep
scripts/drift-ctl wait page selector=video --timeout 8000
scripts/drift-ctl tree page --filter /watch        # drzewo dostępności z [ref] i linkami
scripts/drift-ctl click page 46         # klik po ref (albo po tekście, --right, --double)
scripts/drift-ctl menu "Nowa karta"     # pozycja menu aplikacji
scripts/drift-ctl type sidebar github   # wpisywanie
scripts/drift-ctl key sidebar Enter     # klawisze (--mod cmd,shift)
scripts/drift-ctl text page             # tekst aktywnej strony
scripts/drift-ctl logs                  # błędy konsoli sidebara
```

Wskazywanie elementów (`<sel>`): `12` (ref z `tree`), `button Wyślij` (rola + nazwa dostępności), `Wyślij` (sama nazwa), `css:.tile`, `text:Clear`. Gdy nic nie pasuje, błąd (także timeout `wait el=`) podaje najbardziej podobne elementy. Prefiks `~` (`menuitem ~Szybkość`) akceptuje jedyny podobny element, gdy brak dokładnego — raport oznacza to `≈`. Role pól tekstowych (`textbox`, `combobox`, `searchbox`) są wymienne, a „1.5” == „1,5”.

Cały scenariusz można wysłać w **jednym** zapytaniu (`run`, stop na pierwszym błędzie):

```bash
scripts/drift-ctl run <<'EOF'
open Gmail
wait page el=button Utwórz --timeout 15000
click page button Utwórz
wait page el=textbox Temat
type page kontakt@teceer.com
key page Enter
fill page textbox Temat "Temat maila"
fill page "textbox Treść wiadomości" "Treść"
snapshot page region "Temat maila"
EOF
```

Zawężanie: `--within <sel>` (tylko w kontenerze), `--near <sel>` (element najbliższy kotwicy — ta sama karta/wiersz), `--all`, `--nth N`. Warunki `wait`: `idle` (strona się uspokoiła — pewniejsze niż tytuł w SPA), `heading~`, alternatywa `a | b`, `--fail "<warunek>"`. Zmienne w `run`: `extract page /regex/ --as ids`, potem `${ids[0]}`, `${ids|lines|url}`. `goto <url>` sprawdza, że strona faktycznie się otworzyła (`--new`, `--force`).

Każda komenda zmieniająca stan sama raportuje:
- `Δ` — co zmieniło się w statusie (tryb, URL, paleta, fokus…),
- `→ trafiono` — element, który faktycznie dostał klik; zasłonięty lub niewidoczny cel jest blokowany (`--force` wymusza),
- `✖` — nowe błędy konsoli i nieudane ładowania od poprzedniej komendy,
- `⚠ Drift zrestartował się` — gdy zmieniła się instancja między komendami.

Ze stron raportowane są wyłącznie adres, tytuł, stan ładowania i błędy — treść (`tree page`, `text page`) tylko na żądanie.
