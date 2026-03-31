import { dialog, ipcMain } from 'electron'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import type {
  DawnToolsAccountDirsResponse,
  DawnToolsBrowseRetailResponse,
  DawnToolsSheetCheckResponse,
  DawnToolsLoadGoldlogResponse,
  DawnToolsSyncResponse,
  GoldlogRow,
  GoogleSheetSettings,
} from '../renderer/types'
import { parseGoldlogFromLuaSource } from './luaGoldlog'
import {
  deriveTabNameFromLuaPath,
  ensureSheetAndTab,
  importRowsFromSheet,
  overwriteLuaGoldlog,
  resolveCredentialPath,
  uploadRowsToSheet,
} from './sheetSync'

function validateSettings(settings: GoogleSheetSettings): string | null {
  if (!settings || typeof settings !== 'object') return 'Invalid settings payload.'
  if (!settings.sheetId?.trim()) return 'Sheet ID is required.'
  return null
}

export function registerIpcHandlers() {
  ipcMain.handle('dawntools:browseRetailFolder', async () => {
    try {
      const defaultPath = 'E:\\World of Warcraft\\_retail_'
      const result = await dialog.showOpenDialog({
        title: 'Select World of Warcraft _retail_ folder',
        properties: ['openDirectory'],
        defaultPath,
      })
      if (result.canceled || result.filePaths.length === 0) {
        return { ok: false, error: 'Folder selection was cancelled.' } satisfies DawnToolsBrowseRetailResponse
      }
      const retailPath = result.filePaths[0]?.trim() ?? ''
      if (!retailPath) {
        return { ok: false, error: 'No folder selected.' } satisfies DawnToolsBrowseRetailResponse
      }
      return { ok: true, retailPath } satisfies DawnToolsBrowseRetailResponse
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: message } satisfies DawnToolsBrowseRetailResponse
    }
  })

  ipcMain.handle('dawntools:listAccountDirs', async (_event, retailPath: string) => {
    try {
      const retail = typeof retailPath === 'string' ? retailPath.trim() : ''
      if (!retail) {
        return { ok: false, error: 'Retail folder path is required.' } satisfies DawnToolsAccountDirsResponse
      }

      const accountRoot = path.join(retail, 'WTF', 'Account')
      let stat
      try {
        stat = await fs.stat(accountRoot)
      } catch {
        return {
          ok: false,
          error: `Missing folder: ${accountRoot}`,
        } satisfies DawnToolsAccountDirsResponse
      }
      if (!stat.isDirectory()) {
        return {
          ok: false,
          error: `Not a directory: ${accountRoot}`,
        } satisfies DawnToolsAccountDirsResponse
      }

      const entries = await fs.readdir(accountRoot, { withFileTypes: true })
      const accountDirs = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))

      return { ok: true, accountRoot, accountDirs } satisfies DawnToolsAccountDirsResponse
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: message } satisfies DawnToolsAccountDirsResponse
    }
  })

  ipcMain.handle('dawntools:loadGoldlog', async (_event, dawnToolsLuaPath: string) => {
    try {
      if (typeof dawnToolsLuaPath !== 'string') {
        return { ok: false, error: 'Path must be a string.' } satisfies DawnToolsLoadGoldlogResponse
      }

      const p = dawnToolsLuaPath.trim()
      if (!p) {
        return { ok: false, error: 'Please provide a DawnTools.lua file path.' } satisfies DawnToolsLoadGoldlogResponse
      }

      const base = path.basename(p)
      if (base !== 'DawnTools.lua') {
        return {
          ok: false,
          error: 'Filename must be exactly `DawnTools.lua`.',
        } satisfies DawnToolsLoadGoldlogResponse
      }

      if (path.extname(p).toLowerCase() !== '.lua') {
        return {
          ok: false,
          error: 'File must have a `.lua` extension.',
        } satisfies DawnToolsLoadGoldlogResponse
      }

      let stat
      try {
        stat = await fs.stat(p)
      } catch {
        return {
          ok: false,
          error: 'File not found (or not accessible).',
        } satisfies DawnToolsLoadGoldlogResponse
      }

      if (!stat.isFile()) {
        return {
          ok: false,
          error: 'Provided path is not a file.',
        } satisfies DawnToolsLoadGoldlogResponse
      }

      const source = await fs.readFile(p, 'utf8')
      return await parseGoldlogFromLuaSource(source)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: message } satisfies DawnToolsLoadGoldlogResponse
    }
  })

  ipcMain.handle(
    'dawntools:checkGoogleSheetSettings',
    async (
      _event,
      payload: {
        dawnToolsLuaPath: string
        settings: GoogleSheetSettings
      },
    ) => {
      try {
        const settingsError = validateSettings(payload?.settings)
        if (settingsError) {
          return { ok: false, error: settingsError } satisfies DawnToolsSheetCheckResponse
        }

        const p = payload?.dawnToolsLuaPath?.trim()
        if (!p) {
          return { ok: false, error: 'Lua file path is required.' } satisfies DawnToolsSheetCheckResponse
        }

        const tabName = deriveTabNameFromLuaPath(p)
        const projectRoot = process.env.APP_ROOT ?? process.cwd()
        const credentialsPath = resolveCredentialPath(projectRoot)
        await ensureSheetAndTab(credentialsPath, payload.settings.sheetId.trim(), tabName)
        return { ok: true, resolvedTabName: tabName } satisfies DawnToolsSheetCheckResponse
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return { ok: false, error: message } satisfies DawnToolsSheetCheckResponse
      }
    },
  )

  ipcMain.handle(
    'dawntools:uploadGoldlogToSheet',
    async (
      _event,
      payload: {
        dawnToolsLuaPath: string
        settings: GoogleSheetSettings
        rows: GoldlogRow[]
      },
    ) => {
      try {
        const settingsError = validateSettings(payload?.settings)
        if (settingsError) {
          return { ok: false, error: settingsError } satisfies DawnToolsSyncResponse
        }

        const rows = Array.isArray(payload.rows) ? payload.rows : []
        const p = payload?.dawnToolsLuaPath?.trim()
        if (!p) {
          return { ok: false, error: 'Lua file path is required.' } satisfies DawnToolsSyncResponse
        }
        const tabName = deriveTabNameFromLuaPath(p)
        const projectRoot = process.env.APP_ROOT ?? process.cwd()
        const credentialsPath = resolveCredentialPath(projectRoot)
        await ensureSheetAndTab(credentialsPath, payload.settings.sheetId.trim(), tabName)
        await uploadRowsToSheet(credentialsPath, { sheetId: payload.settings.sheetId.trim(), tabName }, rows)
        return { ok: true, rows } satisfies DawnToolsSyncResponse
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return { ok: false, error: message } satisfies DawnToolsSyncResponse
      }
    },
  )

  ipcMain.handle(
    'dawntools:saveGoldlogToLua',
    async (
      _event,
      payload: {
        dawnToolsLuaPath: string
        rows: GoldlogRow[]
      },
    ) => {
      try {
        const p = payload?.dawnToolsLuaPath?.trim()
        if (!p) {
          return { ok: false, error: 'Lua file path is required.' } satisfies DawnToolsSyncResponse
        }
        const rows = Array.isArray(payload.rows) ? payload.rows : []
        await overwriteLuaGoldlog(p, rows)
        return { ok: true, rows } satisfies DawnToolsSyncResponse
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return { ok: false, error: message } satisfies DawnToolsSyncResponse
      }
    },
  )

  ipcMain.handle(
    'dawntools:importGoldlogFromSheet',
    async (
      _event,
      payload: {
        dawnToolsLuaPath: string
        settings: GoogleSheetSettings
      },
    ) => {
      try {
        const settingsError = validateSettings(payload?.settings)
        if (settingsError) {
          return { ok: false, error: settingsError } satisfies DawnToolsSyncResponse
        }

        const p = payload?.dawnToolsLuaPath?.trim()
        if (!p) {
          return { ok: false, error: 'Lua file path is required.' } satisfies DawnToolsSyncResponse
        }

        const tabName = deriveTabNameFromLuaPath(p)
        const projectRoot = process.env.APP_ROOT ?? process.cwd()
        const credentialsPath = resolveCredentialPath(projectRoot)
        await ensureSheetAndTab(credentialsPath, payload.settings.sheetId.trim(), tabName)
        const rows = await importRowsFromSheet(credentialsPath, { sheetId: payload.settings.sheetId.trim(), tabName })
        await overwriteLuaGoldlog(p, rows)

        return { ok: true, rows } satisfies DawnToolsSyncResponse
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return { ok: false, error: message } satisfies DawnToolsSyncResponse
      }
    },
  )
}

