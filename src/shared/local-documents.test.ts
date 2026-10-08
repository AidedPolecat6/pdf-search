import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { describe, expect, it } from 'vitest'
import { segmentPage } from './provisions'
import { DocumentSearch } from './search'
import type { IndexedFragment } from './types'

const pdfPath = resolve('..', 'Lovgivning', 'BEK 1082 Installationsbekendtgørelsen.pdf')

describe('det lokale dokumentbibliotek', () => {
  it.runIf(existsSync(pdfPath))('finder eksempelspørgsmålet i BEK 1082 på fysisk side 8', async () => {
    const bytes = new Uint8Array(await readFile(pdfPath))
    const hash = createHash('sha256').update(bytes).digest('hex')
    const pdf = await getDocument({ data: bytes }).promise
    const fragments: IndexedFragment[] = []
    let context = undefined

    for (let physicalPage = 1; physicalPage <= pdf.numPages; physicalPage += 1) {
      const page = await pdf.getPage(physicalPage)
      const content = await page.getTextContent()
      const text = content.items
        .filter((item) => 'str' in item)
        .map((item) => 'str' in item ? `${item.str}${item.hasEOL ? '\n' : ' '}` : '')
        .join('')
      const segmented = segmentPage({
        documentPath: pdfPath,
        documentName: 'BEK 1082 Installationsbekendtgørelsen.pdf',
        documentHash: hash,
        physicalPage,
        text,
        source: 'native',
        extractionConfidence: 1,
        previousContext: context
      })
      context = segmented.context
      fragments.push(...segmented.fragments)
    }

    const results = new DocumentSearch(fragments).search(
      'Hvad er kravet til mærkestrømmen for den foransiddende kortslutningsbeskyttelse for en husholdningsstikkontakt med en mærkestrøm på 10 A?'
    )

    expect(results[0].documentName).toContain('BEK 1082')
    expect(results[0].physicalPage).toBe(8)
    expect(results[0].provision).toBe('§ 45, stk. 1, nr. 1')
    expect(results[0].confidence).toBeGreaterThanOrEqual(75)
  }, 30_000)
})
