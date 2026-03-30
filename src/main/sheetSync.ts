import path from 'node:path'
import { promises as fs } from 'node:fs'
import { google } from 'googleapis'
import type { GoldlogRow } from '../renderer/types'

type SheetSettings = {
  sheetId: string
}

const header = ['guildName', 'name', 'gold', 'guildGold', 'faction', 'realm']

function toNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

function toStringValue(value: unknown, fallback = ''): string {
  if (value == null) return fallback
  const text = String(value).trim()
  return text || fallback
}

function normalizeRows(rows: Array<Partial<GoldlogRow>>): GoldlogRow[] {
  return rows.map((row, index) => {
    const name = toStringValue(row.name, 'Unknown')
    const realm = toStringValue(row.realm, 'Unknown')
    return {
      id: `${name}|${realm}|${index}`,
      guildName: toStringValue(row.guildName, 'None'),
      name,
      gold: toNumber(row.gold),
      guildGold: toNumber(row.guildGold),
      faction: toStringValue(row.faction, 'Unknown'),
      realm,
    }
  })
}

async function getSheetsClient(credentialsPath: string) {
  const auth = new google.auth.GoogleAuth({
    keyFile: credentialsPath,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  })
  return google.sheets({ version: 'v4', auth })
}

export async function uploadRowsToSheet(
  credentialsPath: string,
  settings: SheetSettings & { tabName: string },
  rows: GoldlogRow[],
): Promise<void> {
  const sheets = await getSheetsClient(credentialsPath)
  const range = `${settings.tabName}!A1:F`
  const values: (string | number)[][] = [
    header,
    ...rows.map((r) => [r.guildName, r.name, r.gold, r.guildGold, r.faction, r.realm]),
  ]

  await sheets.spreadsheets.values.clear({
    spreadsheetId: settings.sheetId,
    range,
  })

  await sheets.spreadsheets.values.update({
    spreadsheetId: settings.sheetId,
    range,
    valueInputOption: 'RAW',
    requestBody: { values },
  })
}

export async function importRowsFromSheet(
  credentialsPath: string,
  settings: SheetSettings & { tabName: string },
): Promise<GoldlogRow[]> {
  const sheets = await getSheetsClient(credentialsPath)
  const range = `${settings.tabName}!A1:F`
  const result = await sheets.spreadsheets.values.get({
    spreadsheetId: settings.sheetId,
    range,
  })
  const values = result.data.values ?? []
  if (values.length <= 1) return []

  const body = values.slice(1)
  const parsed = body
    .filter((line) => line.some((cell) => String(cell ?? '').trim() !== ''))
    .map((line) => ({
      guildName: line[0],
      name: line[1],
      gold: line[2],
      guildGold: line[3],
      faction: line[4],
      realm: line[5],
    }))

  return normalizeRows(parsed)
}

function luaStringEscape(value: string): string {
  return value.split('\\').join('\\\\').split('"').join('\\"')
}

function toLuaGoldlogTable(rows: GoldlogRow[]): string {
  const lines: string[] = ['{']
  for (const row of rows) {
    const key = `${row.name}-${row.realm}`
    lines.push(`["${luaStringEscape(key)}"] = {`)
    lines.push(`["guildName"] = "${luaStringEscape(row.guildName)}",`)
    lines.push(`["name"] = "${luaStringEscape(row.name)}",`)
    lines.push(`["gold"] = ${Math.trunc(row.gold)},`)
    lines.push(`["guildGold"] = ${Math.trunc(row.guildGold)},`)
    lines.push(`["faction"] = "${luaStringEscape(row.faction)}",`)
    lines.push(`["realm"] = "${luaStringEscape(row.realm)}",`)
    lines.push('},')
  }
  lines.push('}')
  return lines.join('\n')
}

function findMatchingBrace(content: string, openBraceIndex: number): number {
  let depth = 0
  let inDouble = false
  let inSingle = false

  for (let i = openBraceIndex; i < content.length; i += 1) {
    const c = content[i]
    const prev = i > 0 ? content[i - 1] : ''

    if (!inSingle && c === '"' && prev !== '\\') {
      inDouble = !inDouble
      continue
    }
    if (!inDouble && c === "'" && prev !== '\\') {
      inSingle = !inSingle
      continue
    }
    if (inDouble || inSingle) continue

    if (c === '{') depth += 1
    if (c === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }

  return -1
}

export async function overwriteLuaGoldlog(
  dawnToolsLuaPath: string,
  rows: GoldlogRow[],
): Promise<void> {
  const content = await fs.readFile(dawnToolsLuaPath, 'utf8')
  const marker = '["goldlog"] = {'
  const markerIndex = content.indexOf(marker)
  if (markerIndex < 0) {
    throw new Error('Could not locate `["goldlog"] = {` in DawnTools.lua')
  }

  const braceStart = content.indexOf('{', markerIndex)
  if (braceStart < 0) throw new Error('Could not locate opening brace for goldlog table.')

  const braceEnd = findMatchingBrace(content, braceStart)
  if (braceEnd < 0) throw new Error('Could not locate closing brace for goldlog table.')

  const before = content.slice(0, braceStart)
  const after = content.slice(braceEnd + 1)
  const luaTable = toLuaGoldlogTable(rows)
  const nextContent = `${before}${luaTable}${after}`

  await fs.writeFile(dawnToolsLuaPath, nextContent, 'utf8')
}

export function resolveCredentialPath(projectRoot: string): string {
  return path.join(projectRoot, 'northern-math-452403-a6-960f6d9b4386.json')
}

export function deriveTabNameFromLuaPath(dawnToolsLuaPath: string): string {
  const parts = dawnToolsLuaPath.split(/[\\/]+/).filter(Boolean)
  const savedVarsIndex = parts.findIndex((p) => p.toLowerCase() === 'savedvariables')
  if (savedVarsIndex <= 0) {
    throw new Error('Could not derive tab name from path (missing SavedVariables segment).')
  }
  const tab = parts[savedVarsIndex - 1]
  if (!tab) throw new Error('Could not derive account folder before SavedVariables.')
  return tab
}

export async function ensureSheetAndTab(
  credentialsPath: string,
  sheetId: string,
  tabName: string,
): Promise<void> {
  const sheets = await getSheetsClient(credentialsPath)
  const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId })
  const existingNames = new Set(
    (meta.data.sheets ?? [])
      .map((s) => s.properties?.title)
      .filter((t): t is string => Boolean(t)),
  )

  if (!existingNames.has(tabName)) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: {
        requests: [
          {
            addSheet: {
              properties: {
                title: tabName,
              },
            },
          },
        ],
      },
    })
  }
}

