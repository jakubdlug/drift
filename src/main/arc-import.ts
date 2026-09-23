import { app, session } from 'electron'
import { execFile, execFileSync } from 'child_process'
import { promisify } from 'util'
import { createDecipheriv, createHash, pbkdf2Sync } from 'crypto'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import type { HistoryEntry, Item, ItemId, Profile, State, Workspace } from '@shared/types'
import { defaultState } from './store'

const ARC_DIR = join(homedir(), 'Library/Application Support/Arc')
const USER_DATA = join(ARC_DIR, 'User Data')
/** Arc stores timestamps as seconds since 2001-01-01 */
const APPLE_EPOCH = 978307200

type ArcProfileRef = { default: true } | { custom: { _0: { directoryBasename: string } } }

interface ArcItem {
  id: string
  title: string | null
  parentID: string | null
  childrenIds: string[]
  createdAt: number
  data: {
    tab?: { savedURL?: string; savedTitle?: string; timeLastActiveAt?: number }
    list?: object
    splitView?: object
    itemContainer?: { containerType: { topApps?: { _0: ArcProfileRef } } }
  }
}

interface ArcSpace {
  id: string
  title?: string
  profile: ArcProfileRef
  containerIDs: string[]
  customInfo?: { iconType?: { emoji_v2?: string }; windowTheme?: unknown }
}

export interface ImportedProfile {
  profile: Profile
  arcDir: string
}

export function arcAvailable(): boolean {
  return existsSync(join(ARC_DIR, 'StorableSidebar.json'))
}

const profileDir = (ref: ArcProfileRef): string => ('default' in ref ? 'Default' : ref.custom._0.directoryBasename)
const profileId = (dir: string): string => `arc-${dir.toLowerCase().replace(/\s+/g, '-')}`

/** Flat [key, value, key, value] arrays are how Arc serialises dictionaries */
function pairs<T>(arr: unknown[]): Array<[unknown, T]> {
  const out: Array<[unknown, T]> = []
  for (let i = 0; i < arr.length; i += 2) out.push([arr[i], arr[i + 1] as T])
  return out
}

function toHex(c: { red: number; green: number; blue: number }): string {
  const h = (v: number): string => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')
  return `#${h(c.red)}${h(c.green)}${h(c.blue)}`
}

/** Digs the first RGB colour out of Arc's deeply nested theme blob */
function themeColor(theme: unknown): string {
  let found: string | null = null
  const walk = (node: unknown, key = ''): void => {
    if (found || !node || typeof node !== 'object') return
    const n = node as Record<string, unknown>
    if (typeof n.red === 'number' && typeof n.green === 'number' && key === 'color') {
      found = toHex(n as { red: number; green: number; blue: number })
      return
    }
    for (const [k, v] of Object.entries(n)) walk(v, k)
  }
  walk((theme as Record<string, unknown> | undefined)?.background)
  if (!found) walk(theme)
  return found ?? '#1c1c1f'
}

function favicon(itemId: string): string | undefined {
  const hash = createHash('md5').update(itemId).digest('hex')
  const path = join(ARC_DIR, 'SidebarItemsFaviconCache', hash)
  if (!existsSync(path)) return undefined
  return `data:image/png;base64,${readFileSync(path).toString('base64')}`
}

function profileNames(): Record<string, string> {
  try {
    const local = JSON.parse(readFileSync(join(USER_DATA, 'Local State'), 'utf8'))
    const out: Record<string, string> = {}
    for (const [dir, info] of Object.entries(local.profile.info_cache as Record<string, { name: string }>)) out[dir] = info.name
    return out
  } catch {
    return {}
  }
}

/** Reads StorableSidebar.json and maps it onto Drift's state model */
export function importSidebar(): { state: State; profiles: ImportedProfile[] } {
  const raw = JSON.parse(readFileSync(join(ARC_DIR, 'StorableSidebar.json'), 'utf8'))
  const container = (raw.sidebar.containers as Array<Record<string, unknown[]>>).find((c) => c.spaces)!
  const arcItems = new Map(pairs<ArcItem>(container.items).map(([id, it]) => [id as string, it]))
  const spaces = pairs<ArcSpace>(container.spaces).map(([, s]) => s).filter((s) => typeof s === 'object')
  const names = profileNames()

  const base = defaultState()
  const items: Record<ItemId, Item> = {}
  const profiles = new Map<string, ImportedProfile>()

  const ensureProfile = (ref: ArcProfileRef): string => {
    const dir = profileDir(ref)
    const id = profileId(dir)
    if (!profiles.has(id)) {
      const name = dir === 'Default' ? 'Core' : (names[dir] ?? dir)
      profiles.set(id, { profile: { id, name, partition: `persist:${id}` }, arcDir: join(USER_DATA, dir) })
    }
    return id
  }

  /** Converts an Arc item (and its subtree) into Drift items; split views become their tabs */
  const convert = (id: string): ItemId[] => {
    const it = arcItems.get(id)
    if (!it) return []
    if (it.data.tab) {
      const url = it.data.tab.savedURL
      if (!url) return []
      items[id] = {
        id,
        kind: 'tab',
        title: it.title || it.data.tab.savedTitle || url,
        url,
        favicon: favicon(id),
        createdAt: (it.createdAt + APPLE_EPOCH) * 1000,
        lastActiveAt: it.data.tab.timeLastActiveAt ? (it.data.tab.timeLastActiveAt + APPLE_EPOCH) * 1000 : undefined
      }
      return [id]
    }
    if (it.data.splitView) return it.childrenIds.flatMap(convert)
    if (it.data.list) {
      items[id] = {
        id,
        kind: 'folder',
        title: it.title || 'Folder',
        children: it.childrenIds.flatMap(convert),
        collapsed: true,
        createdAt: (it.createdAt + APPLE_EPOCH) * 1000
      }
      return [id]
    }
    return []
  }

  const workspaces: Workspace[] = spaces.map((s) => {
    const containerFor = (kind: string): string | undefined => {
      const i = s.containerIDs.indexOf(kind)
      return i >= 0 ? s.containerIDs[i + 1] : undefined
    }
    const pinnedC = containerFor('pinned')
    const todayC = containerFor('unpinned')
    const pid = ensureProfile(s.profile)
    return {
      id: s.id,
      name: s.title || 'Space',
      emoji: s.customInfo?.iconType?.emoji_v2,
      color: themeColor(s.customInfo?.windowTheme),
      profileId: pid,
      pinned: pinnedC ? (arcItems.get(pinnedC)?.childrenIds ?? []).flatMap(convert) : [],
      today: todayC ? (arcItems.get(todayC)?.childrenIds ?? []).flatMap(convert) : []
    }
  })

  // Essentials ("top apps") are stored per profile
  const essentials: Record<string, ItemId[]> = {}
  for (const [ref, containerId] of pairs<string>(container.topAppsContainerIDs)) {
    const pid = profileId(profileDir(ref as ArcProfileRef))
    if (!profiles.has(pid)) continue
    essentials[pid] = (arcItems.get(containerId)?.childrenIds ?? []).flatMap(convert)
  }

  const imported = [...profiles.values()]
  const state: State = {
    ...base,
    profiles: imported.map((p) => p.profile),
    workspaces,
    essentials,
    items,
    activeWorkspaceId: workspaces[0]?.id ?? base.activeWorkspaceId,
    activeItemByWorkspace: {}
  }
  return { state, profiles: imported }
}

/** Opens a SQLite DB that Arc may hold locked by querying a private copy */
function queryCopy<T>(dbPath: string, sql: string): T[] {
  if (!existsSync(dbPath)) return []
  const dir = mkdtempSync(join(tmpdir(), 'drift-import-'))
  try {
    const copy = join(dir, 'db')
    cpSync(dbPath, copy)
    const out = execFileSync('/usr/bin/sqlite3', ['-json', copy, sql], { maxBuffer: 512 * 1024 * 1024 }).toString()
    return out.trim() ? (JSON.parse(out) as T[]) : []
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export function importHistory(profiles: ImportedProfile[]): HistoryEntry[] {
  const merged = new Map<string, HistoryEntry>()
  for (const p of profiles) {
    // Chromium time: microseconds since 1601-01-01
    const rows = queryCopy<{ url: string; title: string; visit_count: number; t: number }>(
      join(p.arcDir, 'History'),
      "SELECT url, title, visit_count, (last_visit_time/1000 - 11644473600000) AS t FROM urls WHERE hidden = 0 AND url LIKE 'http%' ORDER BY last_visit_time DESC LIMIT 8000"
    )
    for (const r of rows) {
      const prev = merged.get(r.url)
      if (prev) {
        prev.visits += r.visit_count
        prev.lastVisit = Math.max(prev.lastVisit, r.t)
      } else merged.set(r.url, { url: r.url, title: r.title, visits: r.visit_count, lastVisit: r.t })
    }
  }
  return [...merged.values()].sort((a, b) => b.lastVisit - a.lastVisit).slice(0, 20000)
}

/**
 * Copies Local Storage and IndexedDB into Drift's partition directories.
 * Must run before any session for these partitions is created.
 */
export function copyStorage(profiles: ImportedProfile[], log: (m: string) => void): void {
  for (const p of profiles) {
    const target = join(app.getPath('userData'), 'Partitions', p.profile.partition.replace('persist:', ''))
    for (const dir of ['Local Storage', 'IndexedDB']) {
      const src = join(p.arcDir, dir)
      if (!existsSync(src)) continue
      rmSync(join(target, dir), { recursive: true, force: true })
      cpSync(src, join(target, dir), { recursive: true, filter: (f) => !f.endsWith('LOCK') })
    }
    log(`  • ${p.profile.name}: skopiowano Local Storage + IndexedDB`)
  }
}

async function arcCookieKey(): Promise<Buffer> {
  // Triggers a macOS Keychain prompt for "Arc Safe Storage"; async so the window stays usable
  const { stdout } = await promisify(execFile)('/usr/bin/security', ['find-generic-password', '-w', '-s', 'Arc Safe Storage'], {
    timeout: 5 * 60_000
  })
  return pbkdf2Sync(stdout.trim(), 'saltysalt', 1003, 16, 'sha1')
}

interface CookieRow {
  host_key: string
  name: string
  value: string
  enc: string
  path: string
  expires_utc: number
  is_secure: number
  is_httponly: number
  samesite: number
  has_expires: number
}

const SAME_SITE = { [-1]: 'unspecified', 0: 'no_restriction', 1: 'lax', 2: 'strict' } as const
// RFC 6265 token / cookie-octet; anything else has crashed Chromium's network service
const VALID_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const VALID_VALUE = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))])
}

export async function importCookies(profiles: ImportedProfile[], log: (m: string) => void): Promise<void> {
  const key = await arcCookieKey()
  const now = Date.now() / 1000
  for (const p of profiles) {
    const dbPath = join(p.arcDir, 'Cookies')
    const version = Number(queryCopy<{ value: string }>(dbPath, "SELECT value FROM meta WHERE key='version'")[0]?.value ?? 0)
    const rows = queryCopy<CookieRow>(
      dbPath,
      'SELECT host_key, name, value, hex(encrypted_value) AS enc, path, expires_utc, is_secure, is_httponly, samesite, has_expires FROM cookies'
    )
    const ses = session.fromPartition(p.profile.partition)
    let ok = 0
    let failed = 0
    for (const r of rows) {
      let value = r.value
      if (!value && r.enc) {
        const buf = Buffer.from(r.enc, 'hex')
        if (buf.subarray(0, 3).toString() !== 'v10') {
          failed++
          continue
        }
        try {
          const d = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '))
          let plain = Buffer.concat([d.update(buf.subarray(3)), d.final()])
          // Since DB version 24 the value is prefixed with SHA256(host_key)
          if (version >= 24) plain = plain.subarray(32)
          value = plain.toString('utf8')
        } catch {
          failed++
          continue
        }
      }
      const expires = r.has_expires ? r.expires_utc / 1e6 - 11644473600 : undefined
      if (expires && expires < now) continue
      if (!VALID_NAME.test(r.name) || !VALID_VALUE.test(value) || value.length > 4096) {
        failed++
        continue
      }
      const host = r.host_key.replace(/^\./, '')
      try {
        await withTimeout(ses.cookies.set({
          url: `${r.is_secure ? 'https' : 'http'}://${host}${r.path}`,
          name: r.name,
          value,
          // Host-only cookies (no leading dot) must not carry a domain attribute
          domain: r.host_key.startsWith('.') ? r.host_key : undefined,
          path: r.path,
          secure: !!r.is_secure,
          httpOnly: !!r.is_httponly,
          sameSite: SAME_SITE[r.samesite as keyof typeof SAME_SITE] ?? 'unspecified',
          expirationDate: expires
        }), 3000)
        ok++
      } catch {
        failed++
      }
    }
    await withTimeout(ses.cookies.flushStore(), 10000).catch(() => {})
    log(`  • ${p.profile.name}: ${ok} ciasteczek${failed ? ` (${failed} pominięto)` : ''}`)
  }
}
