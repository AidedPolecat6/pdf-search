import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import ExcelJS from 'exceljs'
import type { TruthRecord, TruthSet } from '../shared/types'

export function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') {
    if ('text' in value) return String(value.text)
    if ('result' in value) return String(value.result ?? '')
    if ('richText' in value) return value.richText.map((part) => part.text).join('')
  }
  return String(value).replace(/\s+/g, ' ').trim()
}

function headerKey(value: string): string {
  return value
    .toLocaleLowerCase('da-DK')
    .replace(/æ/g, 'ae')
    .replace(/ø/g, 'o')
    .replace(/å/g, 'a')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '')
}

const FIELD_ALIASES = {
  id: ['id', 'nummer', 'nr'],
  question: ['sporgsmal'],
  document: ['dokumentfil', 'korrektdokument', 'dokument'],
  provision: ['bestemmelse', 'paragraf', 'punkt'],
  physicalPage: ['fysiskpdfside', 'pdfside', 'fysiskside'],
  answer: ['kortsvar', 'svar'],
  explanation: ['facitforklaring', 'forklaring'],
  keywords: ['nogleord', 'eventuellenogleord']
} as const

type Field = keyof typeof FIELD_ALIASES

function fieldFor(value: string): Field | null {
  const key = headerKey(value)
  return (Object.entries(FIELD_ALIASES).find(([, aliases]) => aliases.includes(key as never))?.[0] as Field | undefined) ?? null
}

function makeRecord(values: Partial<Record<Field, string>>, fallbackId: number): TruthRecord | null {
  const question = values.question?.trim() ?? ''
  const document = values.document?.trim() ?? ''
  const provision = values.provision?.trim() ?? ''
  if (!question || !document || !provision) return null
  const pageValue = Number.parseInt(values.physicalPage ?? '', 10)
  return {
    id: values.id?.trim() || String(fallbackId),
    question,
    document,
    provision,
    physicalPage: Number.isFinite(pageValue) ? pageValue : null,
    answer: values.answer?.trim() ?? '',
    explanation: values.explanation?.trim() ?? '',
    keywords: values.keywords?.trim() ?? ''
  }
}

function parseRows(sheet: ExcelJS.Worksheet): TruthRecord[] {
  const headerRow = sheet.getRow(1)
  const columns = new Map<number, Field>()
  headerRow.eachCell((cell, column) => {
    const field = fieldFor(cellText(cell.value))
    if (field) columns.set(column, field)
  })
  if (!columns.has(1) && !Array.from(columns.values()).includes('question')) return []

  const records: TruthRecord[] = []
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const values: Partial<Record<Field, string>> = {}
    for (const [column, field] of columns) values[field] = cellText(sheet.getCell(rowNumber, column).value)
    const record = makeRecord(values, rowNumber - 1)
    if (record) records.push(record)
  }
  return records
}

function parseColumns(sheet: ExcelJS.Worksheet): TruthRecord[] {
  const rows = new Map<number, Field>()
  for (let row = 1; row <= sheet.rowCount; row += 1) {
    const field = fieldFor(cellText(sheet.getCell(row, 1).value))
    if (field) rows.set(row, field)
  }
  if (!Array.from(rows.values()).includes('question')) return []

  const records: TruthRecord[] = []
  for (let column = 2; column <= sheet.columnCount; column += 1) {
    const values: Partial<Record<Field, string>> = {}
    for (const [row, field] of rows) values[field] = cellText(sheet.getCell(row, column).value)
    const record = makeRecord(values, column - 1)
    if (record) records.push(record)
  }
  return records
}

async function findWorkbook(folder: string): Promise<string | null> {
  try {
    const files = await readdir(folder)
    const name = files.find((file) => !file.startsWith('~$') && /^sandheder.*\.xlsx$/i.test(file))
    return name ? join(folder, name) : null
  } catch {
    return null
  }
}

export async function loadTruthSet(folder: string, fallbackFolder?: string): Promise<TruthSet> {
  const sourcePath = await findWorkbook(folder) ?? (fallbackFolder ? await findWorkbook(fallbackFolder) : null)
  if (!sourcePath) return { sourcePath: null, records: [], warnings: ['Intet sandhedsark fundet i dokumentmappen.'] }

  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(sourcePath)
  const sheet = workbook.worksheets[0]
  if (!sheet) return { sourcePath, records: [], warnings: ['Regnearket indeholder ingen faner.'] }

  const records = parseRows(sheet).length ? parseRows(sheet) : parseColumns(sheet)
  const warnings: string[] = []
  if (!records.length) warnings.push('Ingen gyldige sandheder fundet. Kontrollér kolonneoverskrifterne.')
  const missingPages = records.filter((record) => record.physicalPage === null).length
  if (missingPages) warnings.push(`${missingPages} sandheder mangler fysisk PDF-side.`)
  return { sourcePath, records, warnings }
}
