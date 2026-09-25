# Drift

A lightweight Arc-style browser on Electron (Chromium). Vertical tabs with auto-hide, workspaces with isolated sessions, Essentials, pinned tabs with folders, archiving and tab sleeping.

## Start

```bash
npm install
npm run live         # live iteration: sidebar HMR, changes in main → auto-restart
npm run install-app  # build and replace /Applications/Drift.app
npm run dev          # like live, but without auto-restarting the main process
npm run import:arc   # re-import from Arc (overwrites Drift state)
npm run dist         # Drift.app in dist/
```

The first launch imports data from Arc automatically, if Arc is installed.

## Live iteration

`npm run live` closes the installed Drift (the data is shared, and two instances at once would corrupt it) and starts the dev version:

- changes in `src/renderer` (Svelte, CSS) show up immediately, without reloading pages,
- changes in `src/main` / `src/preload` restart the app; state is saved, active tabs come back.

When the version is good: `npm run install-app`.

## What is imported from Arc

- Spaces → workspaces (name, emoji, color), profiles → separate sessions (`persist:arc-*`)
- Essentials (per profile), pinned tabs with folders, Today tabs, favicons
- History (for ⌘T suggestions)
- Sessions: cookies (decrypted with the "Arc Safe Storage" key), Local Storage, IndexedDB

Not imported: passwords, extensions, Boosts, Easels.

## Passwords (import from Safari)

macOS doesn't let other apps read Safari/iCloud Keychain passwords, so the import is a one-time export:

1. Passwords app → **File → Export All Passwords…** → save the CSV
2. Drift → **File → Import passwords from Safari…** → pick the file (Drift offers to move it to the Trash afterwards)

Passwords are stored in `passwords.bin`, encrypted with a key kept in the macOS Keychain. Fill a login form with **Cmd+Shift+L** or right-click a field → **Fill login**. Chrome/Arc/1Password CSV exports work too. Passkeys can't be exported by macOS.

Agents use references, never values: `drift-ctl secrets <site>` → `fill page textbox Password --secret drift://<id>/password`. A reference only types into a page of the same site as the saved entry.

## Shortcuts

| Shortcut | Action |
|---|---|
| ⌘T / ⌘L | New tab / edit address (palette with suggestions) |
| ⌘⇧N | New incognito tab (separate in-memory session, no history or archive) |
| ⌘W / ⌘⇧T | Close tab (Today → archive, returns to the previous tab) / restore |
| ⌘⇧K | Duplicate tab |
| ⌘1…⌘8 / ⌘9 | Nth / last tab (Essentials → pinned → Today) |
| ⌃Tab / ⌃⇧Tab, ⌘⌥↓ / ⌘⌥↑, ⌘⇧] / ⌘⇧[ | Next / previous tab |
| ⌘S | Show/hide sidebar (in hidden mode it slides out at the left edge) |
| ⌘D | Pin / unpin |
| ⌘⇧C | Copy URL |
| ⌘F / ⌘G / ⌘⇧G | Find on page / next / previous |
| ⌘R / ⌘⇧R / ⌘. | Reload / without cache / stop |
| ⌘[ / ⌘] | Back / forward |
| ⌘P / ⌘⌥U | Print / page source |
| ⌘⌥N / ⌘⌃N | New folder / new workspace |
| Ctrl+1…9, ⌘⌥←/→, two-finger swipe | Switch workspaces |

## Architecture

- `src/main/store.ts` — sidebar state (single source of truth), saved to `~/Library/Application Support/Drift/state.json`
- `src/main/tabs.ts` — `WebContentsView` per tab, sleeping after `sleepAfterMin` minutes
- `src/main/index.ts` — window (`BaseWindow`), layout, IPC, Today archiving after `archiveAfterHours`
- `src/main/arc-import.ts` — import from Arc
- `src/renderer` — sidebar in Svelte 5, drawn in a separate transparent `WebContentsView` above the page

## External control (for agents and scripts)

In dev mode (or with the `--control` flag) Drift exposes a control channel on `127.0.0.1` with a random token in `~/Library/Application Support/Drift/control.json` (0600).

```bash
scripts/drift-ctl state                 # workspace, active tab, pinned/today
scripts/drift-ctl status                # flat status: mode, url, peekOpen, palette, focus…
scripts/drift-ctl wait mode=edge animating=false   # wait for a condition instead of sleep
scripts/drift-ctl wait page selector=video --timeout 8000
scripts/drift-ctl tree page --filter /watch        # accessibility tree with [ref] and links
scripts/drift-ctl click page 46         # click by ref (or by text, --right, --double)
scripts/drift-ctl menu "New tab"        # app menu item
scripts/drift-ctl type sidebar github   # typing
scripts/drift-ctl key sidebar Enter     # keys (--mod cmd,shift)
scripts/drift-ctl text page             # text of the active page
scripts/drift-ctl logs                  # sidebar console errors
```

Pointing at elements (`<sel>`): `12` (ref from `tree`), `button Send` (role + accessible name), `Send` (name only), `css:.tile`, `text:Clear`. When nothing matches, the error (including a `wait el=` timeout) lists the most similar elements. The `~` prefix (`menuitem ~Speed`) accepts the only similar element when there is no exact match — the report marks this with `≈`. Text-field roles (`textbox`, `combobox`, `searchbox`) are interchangeable, and "1.5" == "1,5".

An entire scenario can be sent in a **single** request (`run`, stops on the first error):

```bash
scripts/drift-ctl run <<'EOF'
open Gmail
wait page el=button Compose --timeout 15000
click page button Compose
wait page el=textbox Subject
type page recipient@example.com
key page Enter
fill page textbox Subject "Email subject"
fill page "textbox Message body" "Body"
snapshot page region "Email subject"
EOF
```

Narrowing: `--within <sel>` (only inside a container), `--near <sel>` (the element closest to the anchor — same card/row), `--all`, `--nth N`. `wait` conditions: `idle` (the page has settled — more reliable than the title in an SPA), `heading~`, alternative `a | b`, `--fail "<condition>"`. Variables in `run`: `extract page /regex/ --as ids`, then `${ids[0]}`, `${ids|lines|url}`. `goto <url>` verifies that the page actually opened (`--new`, `--force`).

Every state-changing command reports on its own:
- `Δ` — what changed in the status (mode, URL, palette, focus…),
- `→ hit` — the element that actually received the click; an obscured or invisible target is blocked (`--force` forces it),
- `✖` — new console errors and failed loads since the previous command,
- `⚠ Drift restarted` — when the instance changed between commands.

From pages, only the address, title, loading state and errors are reported — content (`tree page`, `text page`) only on request.

## Skill for agents (Claude Code)

`skill/drift-browser/SKILL.md` teaches the agent to control Drift through `drift-ctl` — without screenshots, in whole scenarios in a single request, with passwords from 1Password.

```bash
ln -sfn "$PWD/skill/drift-browser" ~/.claude/skills/drift-browser
ln -sfn "$PWD/scripts/drift-ctl" ~/bin/drift-ctl   # any directory on PATH
```

## License

MIT
