import type { LuaAccount } from './types'

const ACCOUNTS_KEY = 'dawntools.accounts'
const ACTIVE_ACCOUNT_ID_KEY = 'dawntools.activeAccountId'
const LEGACY_DEFAULT_PATH_KEY = 'dawntools.defaultLuaPath'
const CHAR_SELECTIONS_KEY = 'dawntools.charSelections'

function parseCharSelections(raw: string): Record<string, string[]> | null {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const out: Record<string, string[]> = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof k !== 'string' || !Array.isArray(v)) continue
      const keys = v.filter((x): x is string => typeof x === 'string')
      out[k] = keys
    }
    return out
  } catch {
    return null
  }
}

/** Stable key for persisting character selection: saved account id, or path fallback before account is saved. */
export function selectionStorageKey(activeAccountId: string | null, luaPath: string): string {
  if (activeAccountId) return activeAccountId
  const p = luaPath.trim()
  return p ? `path:${p}` : ''
}

export function loadCharSelection(key: string): string[] | null {
  if (!key) return null
  const raw = window.localStorage.getItem(CHAR_SELECTIONS_KEY)
  if (!raw) return null
  const map = parseCharSelections(raw)
  if (!map) return null
  const arr = map[key]
  return Array.isArray(arr) && arr.length > 0 ? arr : null
}

export function saveCharSelection(key: string, keys: string[]): void {
  if (!key) return
  const raw = window.localStorage.getItem(CHAR_SELECTIONS_KEY)
  const map = parseCharSelections(raw ?? '{}') ?? {}
  if (keys.length === 0) {
    delete map[key]
  } else {
    map[key] = [...keys]
  }
  window.localStorage.setItem(CHAR_SELECTIONS_KEY, JSON.stringify(map))
}

export function removeCharSelection(key: string): void {
  if (!key) return
  const raw = window.localStorage.getItem(CHAR_SELECTIONS_KEY)
  const map = parseCharSelections(raw ?? '{}')
  if (!map || !(key in map)) return
  delete map[key]
  window.localStorage.setItem(CHAR_SELECTIONS_KEY, JSON.stringify(map))
}

export function clearAllCharSelections(): void {
  window.localStorage.removeItem(CHAR_SELECTIONS_KEY)
}

function parentFolderLabel(fullPath: string): string {
  const parts = fullPath.trim().split(/[/\\]/).filter(Boolean)
  if (parts.length >= 2) return parts[parts.length - 2] ?? 'Account'
  return 'Account'
}

function parseAccounts(raw: string): LuaAccount[] | null {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return null
    return parsed.filter(
      (x): x is LuaAccount =>
        Boolean(x) &&
        typeof x === 'object' &&
        typeof (x as LuaAccount).id === 'string' &&
        typeof (x as LuaAccount).nickname === 'string' &&
        typeof (x as LuaAccount).luaPath === 'string',
    )
  } catch {
    return null
  }
}

function migrateFromLegacy(): LuaAccount[] {
  const legacy = window.localStorage.getItem(LEGACY_DEFAULT_PATH_KEY)?.trim()
  if (!legacy) return []
  const acc: LuaAccount = {
    id: crypto.randomUUID(),
    nickname: parentFolderLabel(legacy),
    luaPath: legacy,
  }
  window.localStorage.setItem(ACCOUNTS_KEY, JSON.stringify([acc]))
  return [acc]
}

export function loadAccounts(): LuaAccount[] {
  const raw = window.localStorage.getItem(ACCOUNTS_KEY)
  if (raw) {
    const list = parseAccounts(raw)
    if (list) {
      if (list.length > 0) return list
      return []
    }
  }
  return migrateFromLegacy()
}

export function saveAccounts(accounts: LuaAccount[]): void {
  window.localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts))
}

export function loadActiveAccountId(): string | null {
  return window.localStorage.getItem(ACTIVE_ACCOUNT_ID_KEY)
}

export function saveActiveAccountId(id: string | null): void {
  if (!id) window.localStorage.removeItem(ACTIVE_ACCOUNT_ID_KEY)
  else window.localStorage.setItem(ACTIVE_ACCOUNT_ID_KEY, id)
}

export function upsertAccountByPath(
  accounts: LuaAccount[],
  luaPath: string,
  nickname: string,
): { next: LuaAccount[]; accountId: string } {
  const normalizedPath = luaPath.trim()
  const nick = nickname.trim() || 'Account'
  const idx = accounts.findIndex((a) => a.luaPath.trim() === normalizedPath)
  if (idx >= 0) {
    const next = [...accounts]
    next[idx] = { ...next[idx], nickname: nick }
    return { next, accountId: next[idx].id }
  }
  const id = crypto.randomUUID()
  return { next: [...accounts, { id, nickname: nick, luaPath: normalizedPath }], accountId: id }
}
