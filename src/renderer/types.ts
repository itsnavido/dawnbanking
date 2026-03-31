export type AppPage = 'load' | 'charSelect' | 'display'

export type LuaAccount = {
  id: string
  nickname: string
  luaPath: string
}

export type GoldlogRow = {
  id: string
  guildName: string
  name: string
  gold: number
  guildGold: number
  faction: string
  realm: string
}

export type GoldlogColumnKey =
  | 'name'
  | 'realm'
  | 'faction'
  | 'guildName'
  | 'gold'
  | 'guildGold'

export type SortDirection = 'asc' | 'desc'

export type SortState = {
  column: GoldlogColumnKey
  direction: SortDirection
}

export type TableFilters = {
  faction: string
  realm: string
}

export type PaginationState = {
  page: number
  pageSize: number
}

export type DawnToolsLoadGoldlogSuccess = {
  ok: true
  goldlog: GoldlogRow[]
}

export type DawnToolsLoadGoldlogError = {
  ok: false
  error: string
}

export type DawnToolsLoadGoldlogResponse =
  | DawnToolsLoadGoldlogSuccess
  | DawnToolsLoadGoldlogError

export type DawnToolsSyncResponse =
  | {
      ok: true
      rows: GoldlogRow[]
    }
  | {
      ok: false
      error: string
    }

export type GoogleSheetSettings = {
  sheetId: string
}

export type DawnToolsSheetCheckResponse =
  | {
      ok: true
      resolvedTabName: string
    }
  | {
      ok: false
      error: string
    }

export type DawnToolsBrowseRetailResponse =
  | {
      ok: true
      retailPath: string
    }
  | {
      ok: false
      error: string
    }

export type DawnToolsAccountDirsResponse =
  | {
      ok: true
      accountRoot: string
      accountDirs: string[]
    }
  | {
      ok: false
      error: string
    }

