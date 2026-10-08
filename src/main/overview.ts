import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import ExcelJS from 'exceljs'
import type { OverviewEntry, OverviewSet } from '../shared/types'
import { cellText } from './truths'

export function parseOverviewWorkbook(workbook: ExcelJS.Workbook): OverviewEntry[] {
  const entries: OverviewEntry[] = []
  for (const sheet of workbook.worksheets) {
    if (/^overblik$/i.test(sheet.name)) continue
    if (/håndbog\s*183/i.test(sheet.name)) {
      for (let row = 1; row <= sheet.rowCount; row += 1) {
        const page = Number.parseInt(cellText(sheet.getCell(row, 4).value), 10)
        const label = cellText(sheet.getCell(row, 2).value)
        const title = cellText(sheet.getCell(row, 3).value)
        if (label && title && Number.isFinite(page)) entries.push({ document: 'DS/HD 60364', label, title, physicalPage: page })
      }
      continue
    }

    let current: OverviewEntry | null = null
    for (let row = 1; row <= sheet.rowCount; row += 1) {
      const label = cellText(sheet.getCell(row, 1).value)
      const details = [2, 3, 4].map((column) => cellText(sheet.getCell(row, column).value)).filter(Boolean)
      if (/^kapitel\s+\d+/i.test(label) && details.length) {
        current = { document: sheet.name, label, title: details.join(' · '), physicalPage: null }
        entries.push(current)
      } else if (current && details.length) {
        current.title += ` · ${details.join(' · ')}`
      }
    }
  }
  return entries
}

export async function loadOverview(folder: string): Promise<OverviewSet> {
  let sourcePath: string | null = null
  try {
    const files = await readdir(folder)
    const name = files.find((file) => !file.startsWith('~$') && /^oversigt lovgivning pm\.xlsx$/i.test(file))
    if (name) sourcePath = join(folder, name)
  } catch {
    return { sourcePath: null, entries: [], warnings: [] }
  }
  if (!sourcePath) return { sourcePath: null, entries: [], warnings: [] }

  try {
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.readFile(sourcePath)
    const entries = parseOverviewWorkbook(workbook)
    return {
      sourcePath,
      entries,
      warnings: entries.length ? [] : ['Den lokale lovoversigt indeholder ingen genkendelige kapitler.']
    }
  } catch {
    return { sourcePath, entries: [], warnings: ['Den lokale lovoversigt kunne ikke læses og blev sprunget over.'] }
  }
}
