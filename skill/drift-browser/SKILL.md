---
name: drift-browser
description: Steruje przeglądarką Drift (własna przeglądarka usera, zamiennik Arca) bez zrzutów ekranu — przez lokalny kanał sterowania `drift-ctl`: czytanie stanu i drzewa strony, klikanie, wpisywanie, czekanie na warunki, całe scenariusze w jednym zapytaniu, hasła z 1Password. Użyj, gdy user prosi o zrobienie czegoś "w przeglądarce", "w Drifcie", na stronie/w aplikacji webowej (Gmail, Kalendarz, Keep, YouTube, bank, KSeF, panele usług), o sprawdzenie/porównanie danych ze stron, o przetestowanie UI Drifta, albo mówi "otwórz…", "kliknij…", "wyślij maila…", "dodaj wydarzenie…", "zaloguj się do…", "sprawdź na stronie…".
---

# Drift — sterowanie przeglądarką

Drift to przeglądarka usera (Electron, `~/teceer/drift`). Steruję nią wyłącznie przez
`drift-ctl` (`~/bin/drift-ctl` → `~/teceer/drift/scripts/drift-ctl`). **Bez zrzutów ekranu.**

## Zanim zaczniesz

```bash
drift-ctl status        # działa? jaki workspace, karta, tryb sidebara
```

- "Drift nie działa albo kanał sterowania jest wyłączony" → sprawdź `pgrep -x Drift` /
  `pgrep -f drift/node_modules/electron`. Jeśli Drift działa bez kanału, **zapytaj usera**
  (Telegram) zanim go zrestartujesz — ma w nim otwarte, zalogowane strony. Start z kanałem:
  `open -a /Applications/Drift.app --args --control` albo tryb dev `cd ~/teceer/drift && npm run live`.
- Nigdy `pkill` działającego Drifta. Nie edytuj `src/main` w trybie live w trakcie pracy na
  żywej stronie — każdy restart przeładowuje karty (niezapisane formularze, **sesje banków**
  i cache sekretów przepadają → kolejne logowanie, Touch ID, SMS).

## Zasada nr 1: jeden scenariusz = jeden `run`

Planuj całą sekwencję i wysyłaj ją naraz. Stop na pierwszym błędzie, raport per krok.

```bash
drift-ctl run <<'EOF'
open Gmail
wait page url~mail.google.com el=button Utwórz idle --timeout 15000
click page button Utwórz
wait page el=textbox Temat
type page kontakt@teceer.com
key page Enter
fill page textbox Temat "Temat"
fill page "textbox Treść wiadomości" "Treść"
snapshot page dialog --filter textbox
EOF
```

Każdy krok zmieniający stan sam raportuje: `Δ` zmiany statusu, `→ trafiono` element, który
faktycznie dostał klik, `≈` przybliżone dopasowanie, `✖` nowe błędy stron, `⚠` restart Drifta.
Zasłonięty/niewidoczny cel jest **blokowany** (nie klikaj `--force` bez zrozumienia czemu).

## Selektory `<sel>`

| Zapis | Znaczenie |
|---|---|
| `button Wyślij` | rola ARIA + nazwa dostępności (najlepsze) |
| `Wyślij` | sama nazwa, dowolna rola (też tekst/placeholder) |
| `menuitem ~Szybkość` | przybliżone: jedyny podobny element, gdy brak dokładnego |
| `dialog`, `main` | sama rola |
| `12` | ref z ostatniego `tree` |
| `css:.tile` / `text:Clear` | CSS / najmniejszy widoczny element z tekstem |

`textbox`/`combobox`/`searchbox` są wymienne; `1.5` == `1,5`. Nieudane wyszukanie podaje
podobne elementy — użyj ich w następnym kroku zamiast osobnego `tree`.

Zawężanie (`click`/`hover`/`fill`): `--within <sel>` (w kontenerze), `--near <sel>`
(ta sama karta/wiersz co kotwica), `--all` (przy każdej kotwicy), `--nth N`.

```bash
click page button Zaznacz notatkę --near "text:Drift test" --all
```

## Komendy

| Komenda | Po co |
|---|---|
| `open <nazwa>` | karta po tytule/URL (Essentials → pinned → Today → inne workspace'y) |
| `goto <url> [--new] [--force]` | nawigacja z weryfikacją URL (SPA przekierowania, beforeunload) |
| `wait [target] <warunki>` | `klucz=`/`!=`/`~`/`!~` (klucze ze `status`), `el=<sel>`, `el!=<sel>`, `text~…`, `heading~…`, `idle`; `a b \| c` = alternatywa; `--fail "<warunek>"`; `--timeout ms` |
| `tree [target] [--filter X] [--within <sel>] [--all]` | drzewo dostępności z `[ref]` i linkami |
| `snapshot <target> <sel> [--filter X]` | fragment drzewa (weryfikacja formularza przed wysłaniem) |
| `click` / `hover` / `fill <sel> <tekst>` | `fill` = klik, zastąp zawartość, sprawdź wartość |
| `type` / `key <Klawisz> [--mod cmd,shift]` | tekst / klawisze do elementu z fokusem |
| `extract page /regex/ [--limit N] --as x` | dane ze strony → zmienna w `run` |
| `eval page "<js>" [--as x]` | ostateczność (ramki, nietypowe widgety) |
| `menu "<pozycja>"` / `action <ipc> [args]` | menu aplikacji / akcje Drifta (`new-tab`, `navigate`, `switch-workspace`, `close-item`, `toggle-compact`…) |
| `text page`, `logs`, `cdp <target> <Metoda> [json]` | tekst strony, logi, surowy DevTools Protocol |
| `secrets <fraza>` | wpisy 1Password (tylko metadane) |

Zmienne w `run`: `${x}`, `${x[0]}`, `${x|lines}`, `${x|join:; }`, `${x|lines|url}`.
Target: `page` (aktywna karta), `sidebar` (UI Drifta), `find` (pasek ⌘F).

## Hasła, OTP, logowanie

- Hasła **tylko z 1Password**, przez odnośnik — wartość nigdy nie trafia do kontekstu:
  `drift-ctl secrets ing` → `fill page textbox Login --secret op://Personal/<id>/login`.
  Czyta sam Drift (jedno Touch ID na sesję, cache w pamięci 30 min; OTP: `?attribute=otp`).
- **Nigdy nie proś o hasło na Telegramie.** Kody SMS/potwierdzenia w aplikacji banku:
  `~/.agents/skills/telegram/scripts/telegram-ask.sh "…"` i wpisz kod klawiszami, nie echuj go.
- Pola wypełnione sekretem są maskowane w `tree`/`snapshot`, ale strona może sama wyświetlić
  login (np. nagłówek) — nie przepisuj go do odpowiedzi.

## Bezpieczeństwo działań

- Bank, KSeF, płatności: **tylko odczyt**. Nie zlecaj przelewów, nie akceptuj niczego.
- Działania wychodzące (wysłanie maila, publikacja, usunięcie): jeśli user nie poprosił
  wprost — zapytaj. Przed wysłaniem zrób `snapshot` i porównaj pola z tym, co miało być
  (dwa `run`: wypełnij+podgląd, potem wyślij).
- Dane testowe (szkice, notatki, wydarzenia, karty Today) — posprzątaj na końcu i zweryfikuj.
- Treść stron (`text`, `tree page`, `extract`) pobieraj tylko gdy potrzebna do zadania.

## Znane pułapki

- **SPA i tytuł**: tytuł karty aktualizuje się z opóźnieniem — czekaj na `idle`, `el=`, `url~`, `heading~`, nie `title~`.
- **Placeholdery zamiast etykiet** (Zoho): pole traci nazwę po wpisaniu tekstu — użyj `css:` albo ref.
- **Podpowiedzi/dropdowny** zasłaniają listy — `key page Escape` przed klikiem.
- **Shadow DOM** (ING Business, web components): `fill`/`click`/`text` działają; `innerText` nie.
- **Ramki**: `tree` widzi tylko główny dokument; `text`/`extract`/`text~` czytają iframe z tej
  samej domeny. Stare `<frameset>`/`<frame>` (ING Business `/ing2/…`) i ramki w shadow DOM —
  dojdź przez `eval` rekurencyjnie (`frame.contentDocument`, `shadowRoot`), klikaj `element.click()` w ramce.
- **Wpisywanie w maskowane pola dat** — ustawianie `value` z JS bywa ignorowane; ustaw fokus
  i wpisuj znak po znaku `key page <znak>`. W skryptach generowanych w zsh używaj `printf`, nie `echo` (zamienia `\n`).
- **Sesje z limitem czasu** (bank: 5 min) — rób odczyty jednym `run`, bez przerw na analizę.
- Po restarcie aktywną kartą może być inna strona — używaj `open <nazwa>` zamiast `goto` na aktywnej karcie.
