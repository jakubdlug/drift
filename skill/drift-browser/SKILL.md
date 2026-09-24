---
name: drift-browser
description: Controls the Drift browser (the user's own browser, an Arc replacement) without screenshots — through the local `drift-ctl` control channel: reading page state and tree, clicking, typing, waiting for conditions, whole scenarios in a single request, passwords from 1Password. Use when the user asks to do something "in the browser", "in Drift", on a page/in a web app (Gmail, Calendar, Keep, YouTube, banking, KSeF, service dashboards), to check/compare data from pages, to test the Drift UI, or says "open…", "click…", "send an email…", "add an event…", "log in to…", "check on the page…".
---

# Drift — browser control

Drift is the user's browser (Electron, repo `drift`). I control it exclusively through
`drift-ctl` (in PATH, a symlink to `<repo>/scripts/drift-ctl`). **No screenshots.**

## Before you start

```bash
drift-ctl status        # running? which workspace, tab, sidebar mode
```

- "Drift is not running or the control channel is disabled" → check `pgrep -x Drift` /
  `pgrep -f drift/node_modules/electron`. If Drift is running without the channel, **ask the user**
  (Telegram) before restarting it — they have open, logged-in pages in it. Start with the channel:
  `open -a /Applications/Drift.app --args --control` or dev mode `npm run live` in the repo directory.
- Never `pkill` a running Drift. Don't edit `src/main` in live mode while working on a
  live page — every restart reloads the tabs (unsaved forms, **banking sessions**
  and the secrets cache are lost → another login, Touch ID, SMS).

## Rule #1: one scenario = one `run`

Plan the whole sequence and send it all at once. Stop on the first error, report per step.

```bash
drift-ctl run <<'EOF'
open Gmail
wait page url~mail.google.com el=button Compose idle --timeout 15000
click page button Compose
wait page el=textbox Subject
type page recipient@example.com
key page Enter
fill page textbox Subject "Subject"
fill page "textbox Message body" "Body"
snapshot page dialog --filter textbox
EOF
```

Each state-changing step reports on its own: `Δ` status change, `→ hit` the element that
actually received the click, `≈` approximate match, `✖` new page errors, `⚠` Drift restart.
An obscured/invisible target is **blocked** (don't `--force` without understanding why).

## Selectors `<sel>`

| Notation | Meaning |
|---|---|
| `button Send` | ARIA role + accessible name (best) |
| `Send` | name only, any role (also text/placeholder) |
| `menuitem ~Speed` | approximate: the only similar element, when no exact match exists |
| `dialog`, `main` | role only |
| `12` | ref from the last `tree` |
| `css:.tile` / `text:Clear` | CSS / smallest visible element containing the text |

`textbox`/`combobox`/`searchbox` are interchangeable; `1.5` == `1,5`. A failed lookup lists
similar elements — use them in the next step instead of a separate `tree`.

Narrowing (`click`/`hover`/`fill`): `--within <sel>` (inside a container), `--near <sel>`
(same card/row as the anchor), `--all` (at every anchor), `--nth N`.

```bash
click page button "Select note" --near "text:Drift test" --all
```

## Commands

| Command | For |
|---|---|
| `open <name>` | tab by title/URL (Essentials → pinned → Today → other workspaces) |
| `goto <url> [--new] [--force]` | navigation with URL verification (SPA redirects, beforeunload) |
| `wait [target] <conditions>` | `key=`/`!=`/`~`/`!~` (keys from `status`), `el=<sel>`, `el!=<sel>`, `text~…`, `heading~…`, `idle`; `a b \| c` = alternative; `--fail "<condition>"`; `--timeout ms` |
| `tree [target] [--filter X] [--within <sel>] [--all]` | accessibility tree with `[ref]` and links |
| `snapshot <target> <sel> [--filter X]` | tree fragment (verify a form before submitting) |
| `click` / `hover` / `fill <sel> <text>` | `fill` = click, replace content, verify value |
| `type` / `key <Key> [--mod cmd,shift]` | text / keys to the focused element |
| `extract page /regex/ [--limit N] --as x` | data from the page → variable in `run` |
| `eval page "<js>" [--as x]` | last resort (frames, unusual widgets) |
| `menu "<item>"` / `action <ipc> [args]` | app menu / Drift actions (`new-tab`, `navigate`, `switch-workspace`, `close-item`, `toggle-compact`…) |
| `text page`, `logs`, `cdp <target> <Method> [json]` | page text, logs, raw DevTools Protocol |
| `secrets <phrase>` | 1Password entries (metadata only) |

Variables in `run`: `${x}`, `${x[0]}`, `${x|lines}`, `${x|join:; }`, `${x|lines|url}`.
Target: `page` (active tab), `sidebar` (Drift UI), `find` (⌘F bar).

## Passwords, OTP, login

- Passwords **only from 1Password**, via reference — the value never enters the context:
  `drift-ctl secrets ing` → `fill page textbox Login --secret op://Personal/<id>/login`.
  Drift reads it itself (one Touch ID per session, cached in memory for 30 min; OTP: `?attribute=otp`).
- **Never ask for a password in chat or a messenger.** SMS codes / in-app bank confirmations:
  ask the user (e.g. Telegram) and type the code with keystrokes, don't echo it.
- Fields filled with a secret are masked in `tree`/`snapshot`, but the page may display the
  login itself (e.g. a header) — don't copy it into your response.

## Action safety

- Banking, KSeF, payments: **read-only**. Don't order transfers, don't approve anything.
- Ask the user questions during a task (SMS codes, confirmations) through the channel they
  use (e.g. the Telegram skill); don't interrupt the work needlessly.
- Outgoing actions (sending an email, publishing, deleting): if the user didn't explicitly
  ask — ask first. Before sending, run a `snapshot` and compare the fields with what was
  intended (two `run`s: fill+preview, then send).
- Test data (drafts, notes, events, Today tabs) — clean up at the end and verify.
- Fetch page content (`text`, `tree page`, `extract`) only when needed for the task.

## Known pitfalls

- **SPA and the title**: the tab title updates with a delay — wait for `idle`, `el=`, `url~`, `heading~`, not `title~`.
- **Placeholders instead of labels** (Zoho): a field loses its name after text is typed — use `css:` or a ref.
- **Suggestions/dropdowns** cover lists — `key page Escape` before clicking.
- **Shadow DOM** (ING Business, web components): `fill`/`click`/`text` work; `innerText` doesn't.
- **Frames**: `tree` sees only the main document; `text`/`extract`/`text~` read an iframe from the
  same domain. Legacy `<frameset>`/`<frame>` (ING Business `/ing2/…`) and frames inside shadow DOM —
  reach them via `eval` recursively (`frame.contentDocument`, `shadowRoot`), click `element.click()` in the frame.
- **Typing into masked date fields** — setting `value` from JS is sometimes ignored; set focus
  and type character by character with `key page <char>`. In zsh-generated scripts use `printf`, not `echo` (it mangles `\n`).
- **Time-limited sessions** (bank: 5 min) — do reads in a single `run`, without pauses for analysis.
- After a restart the active tab may be a different page — use `open <name>` instead of `goto` on the active tab.
