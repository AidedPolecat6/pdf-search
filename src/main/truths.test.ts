import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import ExcelJS from 'exceljs'
import { describe, expect, it } from 'vitest'
import { DocumentSearch } from '../shared/search'
import type { StoredIndex } from '../shared/types'
import { loadTruthSet } from './truths'

const folder = resolve('..', 'Lovgivning')
const storedIndexPath = process.env.APPDATA ? resolve(process.env.APPDATA, 'ok-pdf', 'document-index.json') : ''

describe('loadTruthSet', () => {
  it('imports a private local truth workbook', async () => {
    const testFolder = await mkdtemp(join(tmpdir(), 'pdf-search-truths-'))
    try {
      const workbook = new ExcelJS.Workbook()
      const sheet = workbook.addWorksheet('Sandheder')
      sheet.addRow(['ID', 'Spørgsmål', 'Korrekt dokument', 'Bestemmelse', 'Fysisk PDF-side', 'Svar', 'Facitforklaring', 'Eventuelle nøgleord', 'Kontrolleret'])
      sheet.addRow(['1', 'Hvor findes prøvekravet?', 'Regelsamling.pdf', '§ 10', 12, 'I § 10', '', 'prøve kontrol', 'Ja'])
      await workbook.xlsx.writeFile(join(testFolder, 'Sandheder privat.xlsx'))

      const truthSet = await loadTruthSet(testFolder)
      expect(truthSet.records).toHaveLength(1)
      expect(truthSet.records[0]).toMatchObject({ question: 'Hvor findes prøvekravet?', document: 'Regelsamling.pdf', provision: '§ 10', physicalPage: 12 })
    } finally {
      await rm(testFolder, { recursive: true, force: true })
    }
  })

  it.runIf(existsSync(folder))('imports the local exam truths workbook', async () => {
    const truthSet = await loadTruthSet(folder)

    expect(truthSet.records).toHaveLength(15)
    expect(truthSet.records[0].question).toContain('ladestandere')
    expect(truthSet.records[0].provision).toContain('722.443.4')
    expect(truthSet.records[14].provision).toContain('41')
    expect(truthSet.records.every((record) => record.physicalPage !== null)).toBe(true)
  })

  it.runIf(existsSync(folder) && existsSync(storedIndexPath))('benchmarks all imported truths against the local index', async () => {
    const truthSet = await loadTruthSet(folder)
    const index = JSON.parse(readFileSync(storedIndexPath, 'utf8')) as StoredIndex
    const benchmark = new DocumentSearch(index.fragments, truthSet.records).benchmark()

    expect(benchmark.total).toBe(15)
    expect(benchmark.top1).toBe(15)
    expect(benchmark.top3, `Sandheder uden for Top-3: ${benchmark.failures.join(', ')}`).toBe(15)
  }, 15_000)
})
