import { lua, lauxlib, lualib, to_luastring } from 'fengari'
import { tojs } from 'fengari-interop'
import type { DawnToolsLoadGoldlogResponse, GoldlogRow } from '../renderer/types'

type ParseCtx = {
  nodeCount: number
  maxNodes: number
  maxDepth: number
  // Detect self-references.
  seenTables: Set<number>
}

function typeName(t: number) {
  // Keep this small: mostly for error/debug messages.
  switch (t) {
    case (lua as any).LUA_TNIL:
      return 'nil'
    case (lua as any).LUA_TBOOLEAN:
      return 'boolean'
    case (lua as any).LUA_TNUMBER:
      return 'number'
    case (lua as any).LUA_TSTRING:
      return 'string'
    case (lua as any).LUA_TTABLE:
      return 'table'
    case (lua as any).LUA_TFUNCTION:
      return 'function'
    case (lua as any).LUA_TUSERDATA:
      return 'userdata'
    case (lua as any).LUA_TTHREAD:
      return 'thread'
    case (lua as any).LUA_TLIGHTUSERDATA:
      return 'lightuserdata'
    default:
      return `lua_type(${t})`
  }
}

function luaKeyToJs(L: any, idx: number): unknown {
  const absIdx = (lua as any).lua_absindex(L, idx)
  const t = (lua as any).lua_type(L, absIdx)
  if (t === (lua as any).LUA_TNUMBER) return (lua as any).lua_tonumber(L, absIdx)
  if (t === (lua as any).LUA_TSTRING) return (lua as any).lua_tojsstring(L, absIdx)
  return `[${typeName(t)} key]`
}

function luaValueToJs(L: any, idx: number, depth: number, ctx: ParseCtx): unknown {
  if (ctx.nodeCount++ > ctx.maxNodes) return '[truncated]'
  if (depth > ctx.maxDepth) return '[max depth]'

  const absIdx = (lua as any).lua_absindex(L, idx)
  const t = (lua as any).lua_type(L, absIdx)

  switch (t) {
    case (lua as any).LUA_TNIL:
      return undefined
    case (lua as any).LUA_TBOOLEAN:
      return Boolean((lua as any).lua_toboolean(L, absIdx))
    case (lua as any).LUA_TNUMBER:
      return (lua as any).lua_tonumber(L, absIdx)
    case (lua as any).LUA_TSTRING:
      // Note: lua_tojsstring can throw if the Lua string can't be represented as JS.
      return (lua as any).lua_tojsstring(L, absIdx)
    case (lua as any).LUA_TTABLE: {
      const ptr = (lua as any).lua_topointer(L, absIdx) as number
      if (ptr && ctx.seenTables.has(ptr)) return '[circular]'
      if (ptr) ctx.seenTables.add(ptr)

      const numericPairs: Array<[number, unknown]> = []
      const obj: Record<string, unknown> = {}

      // Iterate: table, key, value are on the stack.
      ;(lua as any).lua_pushnil(L)
      while ((lua as any).lua_next(L, absIdx) !== 0) {
        const keyIdx = -2
        const valIdx = -1

        const jsKey = luaKeyToJs(L, keyIdx)
        const jsVal = luaValueToJs(L, valIdx, depth + 1, ctx)

        if (typeof jsKey === 'number' && Number.isInteger(jsKey) && jsKey >= 1) {
          numericPairs.push([jsKey, jsVal])
        } else {
          obj[String(jsKey)] = jsVal
        }

        // Remove value, keep key for the next lua_next() call.
        ;(lua as any).lua_pop(L, 1)
      }

      if (ptr) ctx.seenTables.delete(ptr)

      // Try to normalize "array-like" tables to JS arrays.
      if (obj && Object.keys(obj).length === 0 && numericPairs.length > 0) {
        const maxKey = Math.max(...numericPairs.map(([k]) => k))
        const keys = new Set(numericPairs.map(([k]) => k))
        if (keys.size === numericPairs.length && keys.size === maxKey) {
          const arr = new Array(maxKey)
          for (const [k, v] of numericPairs) {
            arr[k - 1] = v
          }
          return arr
        }
      }

      // If not array-like, return an object.
      if (numericPairs.length > 0) {
        for (const [k, v] of numericPairs) obj[String(k)] = v
      }
      return obj
    }
    case (lua as any).LUA_TUSERDATA:
    case (lua as any).LUA_TFUNCTION:
    case (lua as any).LUA_TTHREAD:
    case (lua as any).LUA_TLIGHTUSERDATA:
    default:
      // For non-primitive non-table values, fall back to fengari-interop's conversion.
      // This avoids re-implementing every exotic Lua type.
      try {
        return tojs(L, absIdx)
      } catch {
        return `[${typeName(t)}]`
      }
  }
}

function normalizeGoldlog(converted: unknown): unknown[] {
  if (Array.isArray(converted)) return converted

  if (converted && typeof converted === 'object') {
    const obj = converted as Record<string, unknown>
    const numericKeys = Object.keys(obj)
      .filter((k) => /^\d+$/.test(k))
      .map((k) => Number(k))
      .sort((a, b) => a - b)

    if (numericKeys.length > 0) {
      const maxKey = Math.max(...numericKeys)
      const isDense = numericKeys.length === maxKey && numericKeys[0] === 1
      if (isDense) {
        const arr = new Array(maxKey)
        for (const k of numericKeys) arr[k - 1] = obj[String(k)]
        return arr
      }
    }

    // Most DawnTools goldlog tables are maps like:
    // { ["Some-Name-Realm"] = { ... }, ... }
    // Convert them into a list of entry values for the UI.
    const keys = Object.keys(obj).sort((a, b) => {
      // Keep numeric-ish keys in numeric order, others alphabetically.
      const na = Number(a)
      const nb = Number(b)
      const aNum = Number.isInteger(na) && String(na) === a
      const bNum = Number.isInteger(nb) && String(nb) === b
      if (aNum && bNum) return na - nb
      return a.localeCompare(b)
    })
    return keys.map((k) => obj[k])
  }

  // Primitive goldlog: wrap as a single entry.
  return [converted]
}

function toNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

function toString(value: unknown): string {
  if (value == null) return ''
  return String(value)
}

function normalizeGoldlogRows(entries: unknown[]): GoldlogRow[] {
  const rows: GoldlogRow[] = []
  let fallbackIdx = 0

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    const name = toString(record.name)
    const realm = toString(record.realm)
    const keyBase = `${name || 'unknown'}|${realm || 'unknown'}`
    const id = `${keyBase}|${fallbackIdx++}`

    rows.push({
      id,
      guildName: toString(record.guildName) || 'None',
      name: name || 'Unknown',
      gold: toNumber(record.gold),
      guildGold: toNumber(record.guildGold),
      faction: toString(record.faction) || 'Unknown',
      realm: realm || 'Unknown',
    })
  }

  return rows
}

export async function parseGoldlogFromLuaSource(luaSource: string): Promise<DawnToolsLoadGoldlogResponse> {
  try {
    const L = lauxlib.luaL_newstate()
    lualib.luaL_openlibs(L)

    // Load and execute the saved variables file as plain Lua code.
    const loadStatus = lauxlib.luaL_loadstring(L, to_luastring(luaSource))
    if (loadStatus !== (lua as any).LUA_OK) {
      const message = (lua as any).lua_tojsstring(L, -1)
      return { ok: false, error: `Lua load error: ${message}` }
    }

    const callStatus = (lua as any).lua_pcall(L, 0, 0, 0)
    if (callStatus !== (lua as any).LUA_OK) {
      const message = (lua as any).lua_tojsstring(L, -1)
      return { ok: false, error: `Lua runtime error: ${message}` }
    }

    const LUA_TNIL = (lua as any).LUA_TNIL

    // Extract the goldlog data. Different SavedVariables formats store it in different places.
    const candidates: string[][] = [
      ['goldlog'],
      ['DawnToolsDB', 'goldlog'],
      ['DawnToolsDB', 'global', 'goldlog'],
    ]

    const startTop = (lua as any).lua_gettop(L)
    for (const candidate of candidates) {
      ;(lua as any).lua_settop(L, startTop)

      ;(lua as any).lua_getglobal(L, to_luastring(candidate[0]))
      for (const key of candidate.slice(1)) {
        ;(lua as any).lua_getfield(L, -1, to_luastring(key))
      }

      const topType = (lua as any).lua_type(L, -1)
      if (topType === LUA_TNIL) continue

      const ctx: ParseCtx = {
        nodeCount: 0,
        maxNodes: 20000,
        maxDepth: 12,
        seenTables: new Set(),
      }

      const converted = luaValueToJs(L, -1, 0, ctx)
      const entries = normalizeGoldlog(converted)
      const rows = normalizeGoldlogRows(entries)
      return { ok: true, goldlog: rows }
    }

    return { ok: false, error: 'No `goldlog` found in DawnTools.lua (tried: goldlog, DawnToolsDB.goldlog, DawnToolsDB.global.goldlog).' }

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: message }
  }
}

