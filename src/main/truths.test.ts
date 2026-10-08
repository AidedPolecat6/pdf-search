import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DocumentSearch } from '../shared/search'
import type { StoredIndex } from '../shared/types'
import { loadTruthSet } from './truths'

const folder = resolve('..', 'Lovgivning')
const bundledFolder = resolve('data')
const storedIndexPath = process.env.APPDATA ? resolve(process.env.APPDATA, 'ok-pdf', 'document-index.json') : ''

describe('loadTruthSet', () => {
  it('imports the bundled collaborative truth workbook', async () => {
    const truthSet = await loadTruthSet(resolve('missing-truth-folder'), bundledFolder)

    expect(truthSet.records).toHaveLength(15)
    expect(truthSet.records.every((record) => record.physicalPage !== null)).toBe(true)
    expect(truthSet.sourcePath).toContain('data')
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
