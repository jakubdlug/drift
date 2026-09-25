import { app, Menu, safeStorage, type BaseWindow } from 'electron'
import { createHash } from 'crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'

/**
 * Local password vault, imported from a CSV export of Apple Passwords / Safari
 * (also accepts Chrome/Arc/1Password CSV exports). The file on disk is encrypted with
 * Electron safeStorage — the key lives in the macOS Keychain ("Drift Safe Storage").
 * Passwords never leave the main process except when typed into a page of the same site.
 */
export interface Login {
  id: string
  title: string
  url: string
  host: string
  username: string
  password: string
}

const vaultPath = (): string => join(app.getPath('userData'), 'passwords.bin')

let cache: Login[] | null = null

export function hostOf(url: string): string {
  try {
    const u = new URL(/^[a-z][\w+.-]*:\/\//i.test(url) ? url : `https://${url}`)
    return u.hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return ''
  }
}

/** Same site: identical host or one is a subdomain of the other (login.bank.pl ↔ bank.pl) */
export function sameSite(a: string, b: string): boolean {
  if (!a || !b) return false
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`)
}

function load(): Login[] {
  if (cache) return cache
  if (!existsSync(vaultPath())) return (cache = [])
  cache = JSON.parse(safeStorage.decryptString(readFileSync(vaultPath()))) as Login[]
  return cache
}

function save(list: Login[]): void {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Encryption (Keychain) is unavailable — passwords not saved')
  const tmp = `${vaultPath()}.tmp`
  writeFileSync(tmp, safeStorage.encryptString(JSON.stringify(list)), { mode: 0o600 })
  renameSync(tmp, vaultPath())
  cache = list
}

/** RFC 4180 CSV: quoted fields, doubled quotes, newlines inside quotes */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"'
        i++
      } else if (c === '"') quoted = false
      else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += c
  }
  if (field || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => r.some((f) => f.trim()))
}

/** Imports a CSV export; entries with the same site + username are replaced. Returns counts. */
export function importCsv(file: string): { added: number; updated: number; skipped: number } {
  const rows = parseCsv(readFileSync(file, 'utf8').replace(/^﻿/, ''))
  const header = (rows.shift() ?? []).map((h) => h.trim().toLowerCase())
  const col = (...names: string[]): number => header.findIndex((h) => names.includes(h))
  const iUrl = col('url', 'website', 'login_uri', 'origin')
  const iUser = col('username', 'login', 'login_username', 'user')
  const iPass = col('password', 'login_password')
  const iTitle = col('title', 'name')
  if (iUrl < 0 || iPass < 0) throw new Error('This file does not look like a password export (no URL/Password columns)')

  const list = [...load()]
  let added = 0
  let updated = 0
  let skipped = 0
  for (const r of rows) {
    const url = (r[iUrl] ?? '').trim()
    const password = r[iPass] ?? ''
    const host = hostOf(url)
    if (!host || !password) {
      skipped++
      continue
    }
    const username = iUser >= 0 ? (r[iUser] ?? '').trim() : ''
    const id = createHash('sha256').update(`${host}\n${username}`).digest('hex').slice(0, 10)
    const entry: Login = { id, title: (iTitle >= 0 && r[iTitle]?.trim()) || host, url, host, username, password }
    const at = list.findIndex((l) => l.id === id)
    if (at >= 0) {
      list[at] = entry
      updated++
    } else {
      list.push(entry)
      added++
    }
  }
  save(list)
  return { added, updated, skipped }
}

export function count(): number {
  return load().length
}

/** Logins for the site of a page URL */
export function loginsFor(pageUrl: string): Login[] {
  const host = hostOf(pageUrl)
  if (!/^https:|^http:\/\/(localhost|127\.0\.0\.1)/.test(pageUrl)) return []
  return load().filter((l) => sameSite(l.host, host))
}

/** Metadata search for agents: never returns passwords */
export function search(q: string): { ref: string; title: string; url: string; username: string }[] {
  const needle = q.toLowerCase()
  return load()
    .filter((l) => `${l.title} ${l.host} ${l.username}`.toLowerCase().includes(needle))
    .slice(0, 15)
    .map((l) => ({ ref: `drift://${l.id}`, title: l.title, url: l.url, username: l.username }))
}

/**
 * Resolves drift://<id>/password|username — only for a page on the same site as the entry,
 * so a reference can't be used to type a password into a foreign (phishing) page.
 */
export function readRef(ref: string, pageUrl: string): string {
  const m = ref.match(/^drift:\/\/([0-9a-f]+)(?:\/(password|username))?$/)
  if (!m) throw new Error('Expected drift://<id>/password or drift://<id>/username')
  const entry = load().find((l) => l.id === m[1])
  if (!entry) throw new Error(`No saved password ${ref}`)
  if (!sameSite(entry.host, hostOf(pageUrl))) throw new Error(`Refused: ${ref} belongs to ${entry.host}, the page is ${hostOf(pageUrl) || pageUrl}`)
  return m[2] === 'username' ? entry.username : entry.password
}

/**
 * Types a login into the page: fills the username field (if any) and the password field
 * with native input events so frameworks (React, Angular) register the change.
 */
export async function fillLogin(wc: Electron.WebContents, login: Login): Promise<boolean> {
  if (!sameSite(login.host, hostOf(wc.getURL()))) return false
  return (await wc.executeJavaScript(
    `(() => {
      const visible = (el) => el && el.offsetParent !== null && !el.disabled && !el.readOnly
      const pass = [...document.querySelectorAll('input[type=password]')].find(visible)
      const inputs = [...document.querySelectorAll('input')].filter((el) => visible(el) && /^(text|email|tel|)$/.test(el.type))
      let user = null
      if (pass) {
        const before = inputs.filter((el) => el.compareDocumentPosition(pass) & Node.DOCUMENT_POSITION_FOLLOWING)
        user = before[before.length - 1] || null
      } else {
        user = inputs.find((el) => /user|login|mail|name|id/i.test(el.name + el.id + el.autocomplete + el.placeholder)) || inputs[0] || null
      }
      const set = (el, v) => {
        if (!el) return
        const proto = Object.getPrototypeOf(el)
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v)
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
      }
      if (user && ${JSON.stringify(login.username)}) set(user, ${JSON.stringify(login.username)})
      if (pass) set(pass, ${JSON.stringify(login.password)})
      ;(pass || user)?.focus()
      return !!(pass || user)
    })()`,
    true
  )) as boolean
}

/** Fill login on the page; several accounts for the site → a small menu to pick one */
export function fillLoginInteractive(wc: Electron.WebContents, win: BaseWindow): 'filled' | 'none' | 'menu' {
  const logins = loginsFor(wc.getURL())
  if (!logins.length) return 'none'
  if (logins.length === 1) {
    fillLogin(wc, logins[0]).catch(() => {})
    return 'filled'
  }
  Menu.buildFromTemplate(
    logins.map((l) => ({ label: `${l.username || '(no username)'} — ${l.host}`, click: () => void fillLogin(wc, l).catch(() => {}) }))
  ).popup({ window: win })
  return 'menu'
}
