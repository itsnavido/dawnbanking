import { contextBridge, ipcRenderer } from 'electron'
import type {
  DawnToolsAccountDirsResponse,
  DawnToolsBrowseRetailResponse,
  DawnToolsSheetCheckResponse,
  DawnToolsLoadGoldlogResponse,
  DawnToolsSyncResponse,
  GoldlogRow,
  GoogleSheetSettings,
} from '../renderer/types'

// Expose a minimal, safe API to the renderer.
// The renderer should never touch the filesystem directly.
export function exposeDawnToolsApi() {
  contextBridge.exposeInMainWorld('dawntools', {
    browseRetailFolder: () =>
      ipcRenderer.invoke('dawntools:browseRetailFolder'),
    listAccountDirs: (retailPath: string) =>
      ipcRenderer.invoke('dawntools:listAccountDirs', retailPath),
    loadGoldlog: (dawnToolsLuaPath: string) =>
      ipcRenderer.invoke('dawntools:loadGoldlog', dawnToolsLuaPath),
    uploadGoldlogToSheet: (payload: {
      dawnToolsLuaPath: string
      settings: GoogleSheetSettings
      rows: GoldlogRow[]
    }) => ipcRenderer.invoke('dawntools:uploadGoldlogToSheet', payload),
    checkGoogleSheetSettings: (payload: {
      dawnToolsLuaPath: string
      settings: GoogleSheetSettings
    }) => ipcRenderer.invoke('dawntools:checkGoogleSheetSettings', payload),
    importGoldlogFromSheet: (payload: {
      dawnToolsLuaPath: string
      settings: GoogleSheetSettings
    }) => ipcRenderer.invoke('dawntools:importGoldlogFromSheet', payload),
    saveGoldlogToLua: (payload: {
      dawnToolsLuaPath: string
      rows: GoldlogRow[]
    }) => ipcRenderer.invoke('dawntools:saveGoldlogToLua', payload),
  })
}

declare global {
  interface Window {
    dawntools: {
      browseRetailFolder: () => Promise<DawnToolsBrowseRetailResponse>
      listAccountDirs: (retailPath: string) => Promise<DawnToolsAccountDirsResponse>
      loadGoldlog: (dawnToolsLuaPath: string) => Promise<DawnToolsLoadGoldlogResponse>
      uploadGoldlogToSheet: (payload: {
        dawnToolsLuaPath: string
        settings: GoogleSheetSettings
        rows: GoldlogRow[]
      }) => Promise<DawnToolsSyncResponse>
      checkGoogleSheetSettings: (payload: {
        dawnToolsLuaPath: string
        settings: GoogleSheetSettings
      }) => Promise<DawnToolsSheetCheckResponse>
      importGoldlogFromSheet: (payload: {
        dawnToolsLuaPath: string
        settings: GoogleSheetSettings
      }) => Promise<DawnToolsSyncResponse>
      saveGoldlogToLua: (payload: {
        dawnToolsLuaPath: string
        rows: GoldlogRow[]
      }) => Promise<DawnToolsSyncResponse>
    }
  }
}

