import { useEffect, useMemo, useRef, useState } from 'react'
import {
  clearAllCharSelections,
  loadAccounts,
  loadActiveAccountId,
  loadCharSelection,
  removeCharSelection,
  saveAccounts,
  saveActiveAccountId,
  saveCharSelection,
  selectionStorageKey,
  upsertAccountByPath,
} from './accountsStorage'
import type {
  AppPage,
  DawnToolsAccountDirsResponse,
  DawnToolsLoadGoldlogResponse,
  DawnToolsSyncResponse,
  GoldlogColumnKey,
  GoldlogRow,
  LuaAccount,
  PaginationState,
  SortState,
  TableFilters,
} from './types'

const allColumns: GoldlogColumnKey[] = ['name', 'realm', 'faction', 'guildName', 'gold', 'guildGold']
const defaultVisibleColumns: GoldlogColumnKey[] = ['name', 'realm', 'faction', 'guildName', 'gold', 'guildGold']
const defaultFilters: TableFilters = {
  faction: '',
  realm: '',
}
const defaultPagination: PaginationState = { page: 1, pageSize: 10 }
const defaultSort: SortState = { column: 'name', direction: 'asc' }

function luaBaseName(p: string): string {
  const t = p.trim()
  if (!t) return ''
  return t.split(/[/\\]/).at(-1) ?? ''
}

function normalizePathParts(p: string): string[] {
  return p.trim().split(/[\\/]+/).filter(Boolean)
}

function joinWindowsPath(...parts: string[]): string {
  return parts
    .flatMap((part) => normalizePathParts(part))
    .join('\\')
}

function buildLuaPathFromRetail(retailPath: string, accountDir: string): string {
  return joinWindowsPath(retailPath, 'WTF', 'Account', accountDir, 'SavedVariables', 'DawnTools.lua')
}

async function loadGoldlogFromPath(p: string): Promise<DawnToolsLoadGoldlogResponse> {
  const trimmed = p.trim()
  if (!trimmed) return { ok: false, error: 'Path is empty.' }
  if (luaBaseName(trimmed) !== 'DawnTools.lua') {
    return { ok: false, error: 'Filename must be exactly `DawnTools.lua`.' }
  }
  return window.dawntools.loadGoldlog(trimmed) as Promise<DawnToolsLoadGoldlogResponse>
}

function truncatePathDisplay(full: string, max = 56): string {
  const t = full.trim()
  if (t.length <= max) return t
  return `${t.slice(0, max - 3)}...`
}

function toCharacterKey(row: GoldlogRow): string {
  return `${row.name}|${row.realm}`
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false
  for (const x of a) if (!b.has(x)) return false
  return true
}

function csvEscape(value: string): string {
  if (value.includes('"') || value.includes(',') || value.includes('\n')) {
    return `"${value.split('"').join('""')}"`
  }
  return value
}

function formatGoldUnit(value: number): string {
  return (value / 10000).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })
}

const coinIcon = '🪙'
const guildGoldTarget = 9_999_999

function isKeyboardEditableTarget(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return target.isContentEditable
}

const backArrowIcon = (
  <svg className="card-back-icon" width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
    <path
      fill="currentColor"
      d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"
    />
  </svg>
)
const guildGoldTargetRaw = guildGoldTarget * 10000
type ConfirmDialogState = {
  open: boolean
  title: string
  message: string
  confirmLabel: string
  cancelLabel: string
}

export default function App() {
  const [page, setPage] = useState<AppPage>('load')
  const [path, setPath] = useState('')
  const [retailPath, setRetailPath] = useState('')
  const [availableAccountDirs, setAvailableAccountDirs] = useState<string[]>([])
  const [selectedAccountDir, setSelectedAccountDir] = useState('')
  const [result, setResult] = useState<DawnToolsLoadGoldlogResponse | null>(null)
  const [rows, setRows] = useState<GoldlogRow[]>([])
  const [selectedChars, setSelectedChars] = useState<Set<string>>(new Set())
  const [visibleColumns, setVisibleColumns] = useState<Set<GoldlogColumnKey>>(new Set(defaultVisibleColumns))
  const [sort, setSort] = useState<SortState>(defaultSort)
  const [filters, setFilters] = useState<TableFilters>(defaultFilters)
  const [hideZeroBankBalances, setHideZeroBankBalances] = useState(false)
  const [pagination, setPagination] = useState<PaginationState>(defaultPagination)
  const [expandedRealms, setExpandedRealms] = useState<Set<string>>(new Set())
  const [loadedLuaPath, setLoadedLuaPath] = useState('')
  const [syncStatus, setSyncStatus] = useState('')
  const [lastRefreshAt, setLastRefreshAt] = useState<number | null>(null)
  const [editingCell, setEditingCell] = useState<{ id: string; field: 'gold' | 'guildGold' } | null>(null)
  const [editingValue, setEditingValue] = useState('')
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState>({
    open: false,
    title: '',
    message: '',
    confirmLabel: 'Confirm',
    cancelLabel: 'Cancel',
  })
  const [loading, setLoading] = useState(false)
  const [syncLoading, setSyncLoading] = useState(false)
  const [accounts, setAccounts] = useState<LuaAccount[]>([])
  const [activeAccountId, setActiveAccountId] = useState<string | null>(null)
  const [accountNickname, setAccountNickname] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const confirmResolverRef = useRef<((value: boolean) => void) | null>(null)

  useEffect(() => {
    const accs = loadAccounts()
    setAccounts(accs)
    let aid = loadActiveAccountId()
    if (aid && !accs.some((a) => a.id === aid)) {
      aid = null
      saveActiveAccountId(null)
    }
    setActiveAccountId(aid)
    if (aid) {
      const a = accs.find((x) => x.id === aid)
      if (a) setPath(a.luaPath)
    }
  }, [])

  useEffect(() => {
    return () => {
      if (confirmResolverRef.current) {
        confirmResolverRef.current(false)
        confirmResolverRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' || e.altKey || e.metaKey || e.ctrlKey) return
      if (confirmDialog.open) return
      if (isKeyboardEditableTarget(e.target)) return
      if (page === 'charSelect') {
        e.preventDefault()
        setPage('load')
      } else if (page === 'display') {
        e.preventDefault()
        setPage('charSelect')
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [page, confirmDialog.open])

  const askConfirm = (options: Omit<ConfirmDialogState, 'open'>): Promise<boolean> => {
    return new Promise((resolve) => {
      confirmResolverRef.current = resolve
      setConfirmDialog({
        open: true,
        ...options,
      })
    })
  }

  const closeConfirm = (value: boolean) => {
    setConfirmDialog((prev) => ({ ...prev, open: false }))
    if (confirmResolverRef.current) {
      confirmResolverRef.current(value)
      confirmResolverRef.current = null
    }
  }

  const activeAccountNickname = useMemo(() => {
    if (!loadedLuaPath.trim()) return null
    const a = accounts.find((x) => x.luaPath.trim() === loadedLuaPath.trim())
    return a?.nickname ?? null
  }, [accounts, loadedLuaPath])

  const uniqueChars = useMemo(() => {
    const seen = new Set<string>()
    const output: Array<{ key: string; name: string; realm: string; faction: string; label: string }> = []
    for (const row of rows) {
      const key = toCharacterKey(row)
      if (seen.has(key)) continue
      seen.add(key)
      output.push({
        key,
        name: row.name,
        realm: row.realm,
        faction: row.faction,
        label: `${row.name} - ${row.realm}`,
      })
    }
    output.sort((a, b) => {
      const realmCmp = a.realm.localeCompare(b.realm)
      if (realmCmp !== 0) return realmCmp
      return a.name.localeCompare(b.name)
    })
    return output
  }, [rows])

  const fullCharKeySet = useMemo(() => new Set(uniqueChars.map((c) => c.key)), [uniqueChars])

  const charsByRealm = useMemo(() => {
    const grouped = new Map<string, Array<{ key: string; name: string; realm: string; faction: string; label: string }>>()
    for (const char of uniqueChars) {
      const group = grouped.get(char.realm) ?? []
      group.push(char)
      grouped.set(char.realm, group)
    }
    return Array.from(grouped.entries()).sort((a, b) => {
      const countDiff = b[1].length - a[1].length
      if (countDiff !== 0) return countDiff
      return a[0].localeCompare(b[0])
    })
  }, [uniqueChars])

  const allFactions = useMemo(() => {
    return Array.from(new Set(rows.map((r) => r.faction).filter(Boolean))).sort((a, b) => a.localeCompare(b))
  }, [rows])

  const allRealms = useMemo(() => {
    return Array.from(new Set(rows.map((r) => r.realm).filter(Boolean))).sort((a, b) => a.localeCompare(b))
  }, [rows])

  const filteredRows = useMemo(() => {
    return rows.filter((row) => {
      const charKey = toCharacterKey(row)
      if (selectedChars.size > 0 && !selectedChars.has(charKey)) return false

      if (filters.faction && row.faction !== filters.faction) return false
      if (filters.realm && row.realm !== filters.realm) return false
      if (hideZeroBankBalances && Number(row.guildGold || 0) <= 0) return false

      return true
    })
  }, [rows, selectedChars, filters, hideZeroBankBalances])

  const sortedRows = useMemo(() => {
    const cloned = [...filteredRows]
    cloned.sort((a, b) => {
      const av = a[sort.column]
      const bv = b[sort.column]

      if (typeof av === 'number' && typeof bv === 'number') {
        return sort.direction === 'asc' ? av - bv : bv - av
      }
      const sa = String(av ?? '')
      const sb = String(bv ?? '')
      const cmp = sa.localeCompare(sb, undefined, { sensitivity: 'base' })
      return sort.direction === 'asc' ? cmp : -cmp
    })
    return cloned
  }, [filteredRows, sort])

  const totalPages = useMemo(() => Math.max(1, Math.ceil(sortedRows.length / pagination.pageSize)), [sortedRows.length, pagination.pageSize])
  const currentPage = Math.min(pagination.page, totalPages)
  const pagedRows = useMemo(() => {
    const start = (currentPage - 1) * pagination.pageSize
    return sortedRows.slice(start, start + pagination.pageSize)
  }, [sortedRows, currentPage, pagination.pageSize])

  const selectedCount = selectedChars.size

  useEffect(() => {
    if (page !== 'charSelect' || !loadedLuaPath.trim()) return
    const key = selectionStorageKey(activeAccountId, loadedLuaPath)
    if (!key) return
    if (selectedChars.size === 0) {
      removeCharSelection(key)
      return
    }
    if (setsEqual(selectedChars, fullCharKeySet)) return
    saveCharSelection(key, Array.from(selectedChars))
  }, [selectedChars, page, activeAccountId, loadedLuaPath, fullCharKeySet])

  const applySuccessfulLoad = (p: string, goldlog: GoldlogRow[], nextActiveId: string | null) => {
    setResult({ ok: true, goldlog })
    setRows(goldlog)
    setLoadedLuaPath(p)
    setLastRefreshAt(Date.now())
    setSyncStatus('')
    setExpandedRealms(new Set())
    setFilters(defaultFilters)
    setHideZeroBankBalances(false)
    setSort(defaultSort)
    setPagination(defaultPagination)
    saveActiveAccountId(nextActiveId)
    setActiveAccountId(nextActiveId)

    const key = selectionStorageKey(nextActiveId, p)
    const validKeys = new Set(goldlog.map((r) => toCharacterKey(r)))
    const cached = loadCharSelection(key)
    let useDisplay = false
    if (cached && cached.length > 0) {
      const filtered = cached.filter((k) => validKeys.has(k))
      if (filtered.length > 0) {
        setSelectedChars(new Set(filtered))
        useDisplay = true
      }
    }
    if (!useDisplay) {
      setSelectedChars(new Set(validKeys))
      setPage('charSelect')
    } else {
      setPage('display')
    }
  }

  const handleLoad = async () => {
    const p = path.trim()
    if (!p) return

    setLoading(true)
    try {
      const response = await loadGoldlogFromPath(p)
      setResult(response)
      if (!response.ok) return

      const acc = accounts.find((a) => a.luaPath.trim() === p)
      applySuccessfulLoad(p, response.goldlog, acc?.id ?? null)
    } finally {
      setLoading(false)
    }
  }

  const loadAccountDirsForRetail = async (retail: string): Promise<DawnToolsAccountDirsResponse> => {
    const trimmed = retail.trim()
    if (!trimmed) {
      return { ok: false, error: 'Retail folder path is empty.' }
    }
    const response = await window.dawntools.listAccountDirs(trimmed)
    if (!response.ok) {
      setAvailableAccountDirs([])
      setSelectedAccountDir('')
      setPath('')
      return response
    }
    setAvailableAccountDirs(response.accountDirs)
    const preferred = response.accountDirs.includes(selectedAccountDir)
      ? selectedAccountDir
      : (response.accountDirs[0] ?? '')
    setSelectedAccountDir(preferred)
    setPath(preferred ? buildLuaPathFromRetail(trimmed, preferred) : '')
    return response
  }

  const handleBrowseRetailFolder = async () => {
    setLoading(true)
    try {
      const browse = await window.dawntools.browseRetailFolder()
      if (!browse.ok) {
        setResult({ ok: false, error: browse.error })
        return
      }
      setRetailPath(browse.retailPath)
      const listed = await loadAccountDirsForRetail(browse.retailPath)
      if (!listed.ok) {
        setResult({ ok: false, error: listed.error })
        return
      }
      setResult(null)
    } finally {
      setLoading(false)
    }
  }

  const switchToAccount = async (account: LuaAccount) => {
    if (editingCell) {
      const discard = await askConfirm({
        title: 'Discard cell edit?',
        message: 'You are editing a cell. Switch accounts and discard the unsaved edit?',
        confirmLabel: 'Switch',
        cancelLabel: 'Stay',
      })
      if (!discard) return
      setEditingCell(null)
    }

    setLoading(true)
    try {
      const response = await loadGoldlogFromPath(account.luaPath)
      setResult(response)
      if (!response.ok) {
        setPath(account.luaPath)
        if (page !== 'load') setPage('load')
        return
      }
      setPath(account.luaPath)
      applySuccessfulLoad(account.luaPath, response.goldlog, account.id)
    } finally {
      setLoading(false)
    }
  }

  const handleSaveAccount = async () => {
    const nick = accountNickname.trim()
    if (!nick) {
      setResult({ ok: false, error: 'Enter a nickname for this account.' })
      return
    }
    const p = path.trim()
    if (!p) {
      setResult({ ok: false, error: 'Enter a DawnTools.lua path first.' })
      return
    }

    setLoading(true)
    try {
      const response = await loadGoldlogFromPath(p)
      setResult(response)
      if (!response.ok) return

      const { next, accountId } = upsertAccountByPath(accounts, p, nick)
      saveAccounts(next)
      setAccounts(next)
      applySuccessfulLoad(p, response.goldlog, accountId)
    } finally {
      setLoading(false)
    }
  }

  const removeAccount = async (id: string) => {
    const acc = accounts.find((a) => a.id === id)
    if (!acc) return
    const ok = await askConfirm({
      title: 'Remove account',
      message: `Remove saved account "${acc.nickname}" from the list? Your Lua file on disk is not deleted.`,
      confirmLabel: 'Remove',
      cancelLabel: 'Cancel',
    })
    if (!ok) return

    removeCharSelection(id)
    removeCharSelection(`path:${acc.luaPath.trim()}`)

    const next = accounts.filter((a) => a.id !== id)
    saveAccounts(next)
    setAccounts(next)
    setRenamingId(null)

    if (activeAccountId === id) {
      saveActiveAccountId(null)
      setActiveAccountId(null)
    }

    if (loadedLuaPath.trim() === acc.luaPath.trim()) {
      setRows([])
      setSelectedChars(new Set())
      setLoadedLuaPath('')
      setResult(null)
      setLastRefreshAt(null)
      setFilters(defaultFilters)
      setSort(defaultSort)
      setPagination(defaultPagination)
      setExpandedRealms(new Set())
      setEditingCell(null)
      setSyncStatus('')
      setPage('load')
      setPath('')
    }
  }

  const commitRename = () => {
    if (!renamingId) return
    const nick = renameDraft.trim()
    if (!nick) return
    const next = accounts.map((a) => (a.id === renamingId ? { ...a, nickname: nick } : a))
    saveAccounts(next)
    setAccounts(next)
    setRenamingId(null)
  }

  const accountSelectValue =
    activeAccountId && accounts.some((a) => a.id === activeAccountId) ? activeAccountId : ''

  const onAccountSelectChange = (id: string) => {
    if (!id) return
    const acc = accounts.find((a) => a.id === id)
    if (acc) void switchToAccount(acc)
  }

  const handleRefreshFromLua = async () => {
    const p = (loadedLuaPath || path).trim()
    if (!p) {
      setSyncStatus('No Lua path available to refresh.')
      return
    }

    setLoading(true)
    try {
      const response = await loadGoldlogFromPath(p)
      setResult(response)
      if (!response.ok) return

      setRows(response.goldlog)
      setLoadedLuaPath(p)
      setLastRefreshAt(Date.now())
      setSyncStatus('Data refreshed from Lua file.')

      const availableKeys = new Set(response.goldlog.map((r) => toCharacterKey(r)))
      setSelectedChars((prev) => {
        const next = new Set<string>()
        for (const key of prev) {
          if (availableKeys.has(key)) next.add(key)
        }
        if (next.size === 0) {
          for (const key of availableKeys) next.add(key)
        }
        return next
      })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!loadedLuaPath) return
    const timer = window.setInterval(() => {
      if (loading || syncLoading) return
      void handleRefreshFromLua()
    }, 5 * 60 * 1000)

    return () => window.clearInterval(timer)
  }, [loadedLuaPath, loading, syncLoading])

  const handleSort = (column: GoldlogColumnKey) => {
    setSort((prev) => {
      if (prev.column === column) {
        return {
          column,
          direction: prev.direction === 'asc' ? 'desc' : 'asc',
        }
      }
      return { column, direction: 'asc' }
    })
  }

  const toggleColumn = (column: GoldlogColumnKey) => {
    setVisibleColumns((prev) => {
      const next = new Set(prev)
      if (next.has(column)) {
        if (next.size === 1) return next
        next.delete(column)
      } else {
        next.add(column)
      }
      return next
    })
  }

  const exportCsv = () => {
    const columns = allColumns.filter((c) => visibleColumns.has(c))
    const header = columns.join(',')
    const body = sortedRows
      .map((row) => columns.map((c) => csvEscape(String(row[c] ?? ''))).join(','))
      .join('\n')
    const csv = `${header}\n${body}`
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'goldlog_filtered.csv'
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  const clearAllData = async () => {
    const ok = await askConfirm({
      title: 'Clear All Data',
      message:
        'Remove all loaded goldlog data from the app and return to the file load screen? Your DawnTools.lua file on disk is not changed.',
      confirmLabel: 'Clear All',
      cancelLabel: 'Cancel',
    })
    if (!ok) return

    clearAllCharSelections()
    setRows([])
    setSelectedChars(new Set())
    setLoadedLuaPath('')
    setResult(null)
    setLastRefreshAt(null)
    setFilters(defaultFilters)
    setSort(defaultSort)
    setPagination(defaultPagination)
    setExpandedRealms(new Set())
    setEditingCell(null)
    setSyncStatus('')
    setPage('load')
  }

  const beginEditCell = (row: GoldlogRow, field: 'gold' | 'guildGold') => {
    setEditingCell({ id: row.id, field })
    setEditingValue((Number(row[field]) / 10000).toFixed(2))
  }

  const commitEditCell = async (row: GoldlogRow, field: 'gold' | 'guildGold') => {
    const parsed = Number(editingValue)
    setEditingCell(null)
    if (!Number.isFinite(parsed)) return
    if (!loadedLuaPath) {
      setSyncStatus('Load a DawnTools.lua file first.')
      return
    }

    const raw = Math.max(0, Math.trunc(parsed * 10000))
    const oldRaw = Number(row[field] || 0)
    if (raw === oldRaw) return

    const confirmed = await askConfirm({
      title: 'Save Cell Change',
      message: `Save ${field} change for ${row.name}-${row.realm}?`,
      confirmLabel: 'Save Change',
      cancelLabel: 'Discard',
    })
    if (!confirmed) return

    const updatedRows = rows.map((r) => (r.id === row.id ? { ...r, [field]: raw } : r))
    setSyncLoading(true)
    setSyncStatus('')
    try {
      const response = await window.dawntools.saveGoldlogToLua({
        dawnToolsLuaPath: loadedLuaPath,
        rows: updatedRows,
      }) as DawnToolsSyncResponse
      if (!response.ok) {
        setSyncStatus(`Save failed: ${response.error}`)
        return
      }
      setRows(updatedRows)
      setSyncStatus(`Saved ${field} for ${row.name}-${row.realm}.`)
      setLastRefreshAt(Date.now())
    } finally {
      setSyncLoading(false)
    }
  }

  const removeCharacterFromList = (characterKey: string) => {
    setRows((prev) => prev.filter((row) => toCharacterKey(row) !== characterKey))
    setSelectedChars((prev) => {
      const next = new Set(prev)
      next.delete(characterKey)
      return next
    })
  }

  const activeColumns = allColumns.filter((c) => visibleColumns.has(c))
  const goldSum = useMemo(() => sortedRows.reduce((acc, row) => acc + Number(row.gold || 0), 0), [sortedRows])
  const guildGoldSum = useMemo(() => sortedRows.reduce((acc, row) => acc + Number(row.guildGold || 0), 0), [sortedRows])

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-title-row">
          <h1>🛠️ Dawn Banking</h1>
          {activeAccountNickname ? (
            <span className="pill app-account-pill" title={loadedLuaPath}>
              {activeAccountNickname}
            </span>
          ) : null}
        </div>
        <p>Load SavedVariables, pick characters, and explore your economy data.</p>
      </header>

      {page === 'load' && (
        <section className="card">
          <h2>📂 Load File</h2>
          <label className="label">
            WoW retail folder
            <input
              className="input"
              value={retailPath}
              onChange={(e) => setRetailPath(e.target.value)}
              placeholder="E:\\World of Warcraft\\_retail_"
            />
          </label>

          <label className="label">
            WTF account folder
            <select
              className="input"
              value={selectedAccountDir}
              onChange={(e) => {
                const next = e.target.value
                setSelectedAccountDir(next)
                setPath(next ? buildLuaPathFromRetail(retailPath, next) : '')
              }}
              disabled={availableAccountDirs.length === 0}
            >
              <option value="">
                {availableAccountDirs.length === 0 ? 'No account folders found' : 'Select account folder'}
              </option>
              {availableAccountDirs.map((dir) => (
                <option key={dir} value={dir}>
                  {dir}
                </option>
              ))}
            </select>
          </label>

          <label className="label">
            Auto-selected DawnTools.lua path
            <input className="input" value={path} readOnly />
          </label>

          <label className="label">
            Account nickname (when saving)
            <input
              className="input"
              value={accountNickname}
              onChange={(e) => setAccountNickname(e.target.value)}
              placeholder="e.g. Main, EU alt"
            />
          </label>

          <div className="row gap-sm wrap">
            <button className="btn btn-secondary" type="button" disabled={loading} onClick={() => void handleBrowseRetailFolder()}>
              📁 Browse Retail
            </button>
            <button
              className="btn btn-secondary"
              type="button"
              disabled={loading || retailPath.trim().length === 0}
              onClick={() => void loadAccountDirsForRetail(retailPath)}
            >
              🔎 Find WTF Accounts
            </button>
            <button className="btn" type="button" disabled={loading || path.trim().length === 0} onClick={handleLoad}>
              {loading ? '⏳ Loading...' : '✅ Load'}
            </button>
            <button
              className="btn btn-secondary"
              type="button"
              disabled={loading || path.trim().length === 0}
              onClick={() => void handleSaveAccount()}
            >
              {loading ? '⏳ Working...' : '💾 Save account'}
            </button>
          </div>

          {accounts.length > 0 ? (
            <>
              <h3 className="accounts-heading">Saved accounts</h3>
              <ul className="account-list">
                {accounts.map((a) => (
                  <li key={a.id} className="account-row">
                    {renamingId === a.id ? (
                      <div className="account-row-rename row gap-sm wrap">
                        <input
                          className="input account-rename-input"
                          value={renameDraft}
                          onChange={(e) => setRenameDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commitRename()
                            if (e.key === 'Escape') setRenamingId(null)
                          }}
                          autoFocus
                        />
                        <button type="button" className="btn btn-secondary btn-mini" onClick={commitRename}>
                          Save
                        </button>
                        <button type="button" className="btn btn-ghost btn-mini" onClick={() => setRenamingId(null)}>
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <>
                        <div className="account-row-main">
                          <strong className="account-nickname">{a.nickname}</strong>
                          <span className="account-path" title={a.luaPath}>
                            {truncatePathDisplay(a.luaPath)}
                          </span>
                        </div>
                        <div className="account-row-actions row gap-sm wrap">
                          <button
                            type="button"
                            className="btn btn-secondary btn-mini"
                            disabled={loading || syncLoading}
                            onClick={() => void switchToAccount(a)}
                          >
                            Switch
                          </button>
                          <button
                            type="button"
                            className="btn btn-ghost btn-mini"
                            onClick={() => {
                              setRenamingId(a.id)
                              setRenameDraft(a.nickname)
                            }}
                          >
                            Rename
                          </button>
                          <button type="button" className="btn btn-ghost btn-mini" onClick={() => void removeAccount(a.id)}>
                            Remove
                          </button>
                        </div>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          {result?.ok === false && <pre className="error-text">{result.error}</pre>}
        </section>
      )}

      {page === 'charSelect' && (
        <section className="card card-with-back-nav">
          <div className="card-back-nav">
            <button
              type="button"
              className="card-back-btn"
              onClick={() => setPage('load')}
              title="Back to file load (←)"
            >
              {backArrowIcon}
              <span>Back to Load</span>
            </button>
          </div>
          <div className="row space-between">
            <h2>👥 Character Select</h2>
            <span className="pill">Selected: {selectedCount} / {uniqueChars.length}</span>
          </div>
          <div className="row gap-sm wrap">
            {accounts.length > 0 ? (
              <label className="account-select-wrap">
                <span className="account-select-label">Account</span>
                <select
                  className="input account-select"
                  value={accountSelectValue}
                  disabled={loading || syncLoading}
                  onChange={(e) => onAccountSelectChange(e.target.value)}
                >
                  <option value="">Switch…</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id} title={a.luaPath}>
                      {a.nickname}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <button
              className="btn btn-secondary"
              type="button"
              onClick={() => setSelectedChars(new Set(uniqueChars.map((c) => c.key)))}
            >
              ✅ Select All
            </button>
            <button className="btn btn-secondary" type="button" onClick={() => setSelectedChars(new Set())}>
              🧹 Clear All
            </button>
            <button
              className="btn btn-secondary"
              type="button"
              disabled={loading || syncLoading || !loadedLuaPath}
              onClick={handleRefreshFromLua}
            >
              {loading ? '🔄 Refreshing...' : '🔄 Refresh from Lua'}
            </button>
            <button
              className="btn"
              type="button"
              disabled={selectedCount === 0}
              onClick={() => {
                setPagination((p) => ({ ...p, page: 1 }))
                const key = selectionStorageKey(activeAccountId, loadedLuaPath)
                if (key) saveCharSelection(key, Array.from(selectedChars))
                setPage('display')
              }}
            >
              🚀 Show Selected
            </button>
            <button className="btn btn-ghost" type="button" onClick={() => void clearAllData()}>
              🧨 Clear all data
            </button>
          </div>

          <div className="character-list">
            {charsByRealm.map(([realm, chars]) => (
              <div key={realm} className="realm-group">
                <div className="realm-header">
                  <button
                    className="realm-toggle"
                    type="button"
                    onClick={() => {
                      setExpandedRealms((prev) => {
                        const next = new Set(prev)
                        if (next.has(realm)) next.delete(realm)
                        else next.add(realm)
                        return next
                      })
                    }}
                  >
                    {expandedRealms.has(realm) ? '▾' : '▸'} {realm} ({chars.length})
                  </button>
                  <div className="realm-actions">
                    <button
                      className="btn btn-secondary btn-mini"
                      type="button"
                      onClick={() => {
                        setSelectedChars((prev) => {
                          const next = new Set(prev)
                          for (const char of chars) next.add(char.key)
                          return next
                        })
                      }}
                    >
                      ✅ Realm
                    </button>
                    <button
                      className="btn btn-ghost btn-mini"
                      type="button"
                      onClick={() => {
                        setSelectedChars((prev) => {
                          const next = new Set(prev)
                          for (const char of chars) next.delete(char.key)
                          return next
                        })
                      }}
                    >
                      🧹 Realm
                    </button>
                  </div>
                </div>
                {expandedRealms.has(realm) && (
                  <>
                    {chars.map((char) => (
                      <label key={char.key} className="character-row">
                        <input
                          type="checkbox"
                          checked={selectedChars.has(char.key)}
                          onChange={(e) => {
                            setSelectedChars((prev) => {
                              const next = new Set(prev)
                              if (e.target.checked) next.add(char.key)
                              else next.delete(char.key)
                              return next
                            })
                          }}
                        />
                        <span>{char.name} ({char.faction})</span>
                      </label>
                    ))}
                  </>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {page === 'display' && (
        <section className="card card-with-back-nav">
          <div className="card-back-nav">
            <button
              type="button"
              className="card-back-btn"
              onClick={() => setPage('charSelect')}
              title="Back to character select (←)"
            >
              {backArrowIcon}
              <span>Char Select</span>
            </button>
          </div>
          <div className="row space-between wrap">
            <h2>
              📊 Display Table · 🪙 Gold Sum: {formatGoldUnit(goldSum)} · 🪙 GuildGold Sum: {formatGoldUnit(guildGoldSum)}
            </h2>
            <div className="row gap-sm">
              <span className="pill">Filtered: {sortedRows.length}</span>
              <span className="pill">Total: {rows.length}</span>
              <span className="pill">
                Last refresh: {lastRefreshAt ? new Date(lastRefreshAt).toLocaleTimeString() : 'N/A'}
              </span>
            </div>
          </div>

          <div className="row gap-sm wrap toolbar">
            {accounts.length > 0 ? (
              <label className="account-select-wrap">
                <span className="account-select-label">Account</span>
                <select
                  className="input account-select"
                  value={accountSelectValue}
                  disabled={loading || syncLoading}
                  onChange={(e) => onAccountSelectChange(e.target.value)}
                >
                  <option value="">Switch…</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id} title={a.luaPath}>
                      {a.nickname}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <button
              className="btn btn-secondary"
              type="button"
              disabled={loading || syncLoading || !loadedLuaPath}
              onClick={handleRefreshFromLua}
            >
              {loading ? '🔄 Refreshing...' : '🔄 Refresh'}
            </button>
            <button
              className="btn btn-secondary"
              type="button"
              onClick={() => {
                setFilters(defaultFilters)
                setHideZeroBankBalances(false)
                setSort(defaultSort)
                setPagination(defaultPagination)
              }}
            >
              ♻️ Reset filters
            </button>
            <button className="btn" type="button" onClick={exportCsv}>📤 Export CSV</button>
            <button className="btn btn-ghost" type="button" onClick={() => void clearAllData()}>
              🧨 Clear all data
            </button>
            {syncStatus ? <span className="sync-status">{syncStatus}</span> : null}
          </div>

          <div className="filters-grid filters-grid-slim">
            <select
              className="input"
              value={filters.faction}
              onChange={(e) => {
                setFilters((f) => ({ ...f, faction: e.target.value }))
                setPagination((p) => ({ ...p, page: 1 }))
              }}
            >
              <option value="">All factions</option>
              {allFactions.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
            <select
              className="input"
              value={filters.realm}
              onChange={(e) => {
                setFilters((f) => ({ ...f, realm: e.target.value }))
                setPagination((p) => ({ ...p, page: 1 }))
              }}
            >
              <option value="">All realms</option>
              {allRealms.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <select
              className="input"
              value={pagination.pageSize}
              onChange={(e) => {
                const size = Number(e.target.value) || 10
                setPagination({ page: 1, pageSize: size })
              }}
            >
              {[10, 25, 50, 100].map((size) => (
                <option key={size} value={size}>
                  Page size: {size}
                </option>
              ))}
            </select>
            <label className="row gap-sm" style={{ alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={hideZeroBankBalances}
                onChange={(e) => {
                  setHideZeroBankBalances(e.target.checked)
                  setPagination((p) => ({ ...p, page: 1 }))
                }}
              />
              Hide 0 bank balances
            </label>
          </div>

          <div className="row wrap gap-sm columns-row">
            <details className="columns-dropdown">
              <summary>Visible columns ▾</summary>
              <div className="columns-dropdown-menu">
                {allColumns.map((column) => (
                  <label key={column} className="column-chip">
                    <input
                      type="checkbox"
                      checked={visibleColumns.has(column)}
                      onChange={() => toggleColumn(column)}
                    />
                    {column}
                  </label>
                ))}
              </div>
            </details>
          </div>

          <div className="table-meta">
            Showing {pagedRows.length} rows on page {currentPage}/{totalPages} (filtered: {sortedRows.length}, total: {rows.length})
          </div>

          <div className="table-wrap">
            <table className="modern-table">
              <thead>
                <tr>
                  {activeColumns.map((column) => (
                    <th
                      key={column}
                      className="sortable"
                      onClick={() => handleSort(column)}
                    >
                      {(column === 'gold' || column === 'guildGold') ? `${coinIcon} ${column}` : column}
                      {sort.column === column ? (sort.direction === 'asc' ? '↑' : '↓') : ''}
                    </th>
                  ))}
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {pagedRows.map((row) => (
                  <tr key={row.id}>
                    {activeColumns.map((column) => (
                      <td key={`${row.id}-${column}`}>
                        {column === 'guildGold' ? (
                          <div>
                            {editingCell?.id === row.id && editingCell.field === 'guildGold' ? (
                              <div className="row gap-sm">
                                <span>{coinIcon}</span>
                                <input
                                  className="input table-edit-input"
                                  type="number"
                                  min={0}
                                  step="0.01"
                                  autoFocus
                                  value={editingValue}
                                  onChange={(e) => setEditingValue(e.target.value)}
                                  onBlur={() => { void commitEditCell(row, 'guildGold') }}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') void commitEditCell(row, 'guildGold')
                                    if (e.key === 'Escape') setEditingCell(null)
                                  }}
                                />
                              </div>
                            ) : (
                              <div onClick={() => beginEditCell(row, 'guildGold')} className="editable-value">
                                {`${coinIcon} ${formatGoldUnit(Number(row[column]))}`}
                              </div>
                            )}
                            {Math.max(0, guildGoldTargetRaw - Number(row.guildGold || 0)) > 0 ? (
                              <div className="guildgold-remaining">
                                {coinIcon} {formatGoldUnit(Math.max(0, guildGoldTargetRaw - Number(row.guildGold || 0)))} left
                              </div>
                            ) : null}
                          </div>
                        ) : column === 'gold' ? (
                          editingCell?.id === row.id && editingCell.field === 'gold' ? (
                            <div className="row gap-sm">
                              <span>{coinIcon}</span>
                              <input
                                className="input table-edit-input"
                                type="number"
                                min={0}
                                step="0.01"
                                autoFocus
                                value={editingValue}
                                onChange={(e) => setEditingValue(e.target.value)}
                                onBlur={() => { void commitEditCell(row, 'gold') }}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') void commitEditCell(row, 'gold')
                                  if (e.key === 'Escape') setEditingCell(null)
                                }}
                              />
                            </div>
                          ) : (
                            <div onClick={() => beginEditCell(row, 'gold')} className="editable-value">
                              {`${coinIcon} ${formatGoldUnit(Number(row[column]) < 1000 ? 0 : Number(row[column]))}`}
                            </div>
                          )
                        ) : (
                          String(row[column] ?? '')
                        )}
                      </td>
                    ))}
                    <td>
                      <button
                        className="btn btn-ghost btn-mini"
                        type="button"
                        title="Remove this character from list"
                        onClick={() => removeCharacterFromList(toCharacterKey(row))}
                      >
                        🗑 Remove
                      </button>
                    </td>
                  </tr>
                ))}
                {pagedRows.length === 0 && (
                  <tr>
                    <td colSpan={activeColumns.length + 1} className="empty-cell">
                      No rows match current filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="row gap-sm pagination-row">
            <button
              className="btn btn-secondary"
              type="button"
              disabled={currentPage <= 1}
              onClick={() => setPagination((p) => ({ ...p, page: Math.max(1, p.page - 1) }))}
            >
              Prev
            </button>
            <button
              className="btn btn-secondary"
              type="button"
              disabled={currentPage >= totalPages}
              onClick={() => setPagination((p) => ({ ...p, page: Math.min(totalPages, p.page + 1) }))}
            >
              Next
            </button>
          </div>
        </section>
      )}

      {confirmDialog.open && (
        <div className="confirm-overlay" role="dialog" aria-modal="true">
          <div className="confirm-modal">
            <h3>{confirmDialog.title}</h3>
            <p>{confirmDialog.message}</p>
            <div className="row gap-sm confirm-actions">
              <button className="btn btn-secondary" type="button" onClick={() => closeConfirm(false)}>
                {confirmDialog.cancelLabel}
              </button>
              <button className="btn" type="button" onClick={() => closeConfirm(true)}>
                {confirmDialog.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

