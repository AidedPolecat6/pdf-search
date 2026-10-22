import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import ExcelJS from 'exceljs'
import { describe, expect, it } from 'vitest'
import { DocumentSearch } from '../shared/search'
import type { StoredIndex } from '../shared/types'
import { loadOverview, parseOverviewWorkbook } from './overview'
import { loadTruthSet } from './truths'

const localFolder = resolve('..', 'Lovgivning')
const storedIndexPath = process.env.APPDATA ? resolve(process.env.APPDATA, 'ok-pdf', 'document-index.json') : ''

describe('loadOverview', () => {
  it('parses chapter titles and page-anchored handbook sections', () => {
    const workbook = new ExcelJS.Workbook()
    const law = workbook.addWorksheet('Regelsamling')
    law.addRow(['Kapitel 2', 'Særlige regler', '§10 Prøvekrav'])
    law.addRow(['', '', '§11 Kontrol'])
    const handbook = workbook.addWorksheet('Håndbog 183')
    handbook.addRow(['Standarddel', 'Del 7-999', 'Særlige prøveinstallationer', 123])

    expect(parseOverviewWorkbook(workbook)).toEqual([
      { document: 'Regelsamling', label: 'Kapitel 2', title: 'Særlige regler · §10 Prøvekrav · §11 Kontrol', physicalPage: null },
      { document: 'DS/HD 60364', label: 'Del 7-999', title: 'Særlige prøveinstallationer', physicalPage: 123 }
    ])
  })

  it.runIf(existsSync(resolve(localFolder, 'Oversigt lovgivning PM.xlsx')))('loads the local teacher workbook without bundling it', async () => {
    const overview = await loadOverview(localFolder)

    expect(overview.sourcePath).toContain('Oversigt lovgivning PM.xlsx')
    expect(overview.entries.length).toBeGreaterThan(50)
  })

  it('ignores an unreadable optional overview', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'pdf-search-overview-'))
    try {
      await writeFile(join(folder, 'Oversigt lovgivning PM.xlsx'), 'not an Excel workbook')
      const overview = await loadOverview(folder)

      expect(overview.entries).toEqual([])
      expect(overview.warnings[0]).toContain('sprunget over')
    } finally {
      await rm(folder, { recursive: true, force: true })
    }
  })

  it.runIf(existsSync(resolve(localFolder, 'Oversigt lovgivning PM.xlsx')) && existsSync(storedIndexPath))('enriches local search without changing truth accuracy', async () => {
    const [overview, truths] = await Promise.all([loadOverview(localFolder), loadTruthSet(localFolder)])
    const index = JSON.parse(readFileSync(storedIndexPath, 'utf8')) as StoredIndex
    const search = new DocumentSearch(index.fragments, truths.records, overview.entries)

    expect(search.benchmark()).toMatchObject({ total: 15, top1: 15, top3: 15 })
  }, 15_000)
})
