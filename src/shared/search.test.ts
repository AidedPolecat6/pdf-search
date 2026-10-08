import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DocumentSearch } from './search'
import type { IndexedFragment, StoredIndex } from './types'

const storedIndexPath = process.env.APPDATA ? join(process.env.APPDATA, 'ok-pdf', 'document-index.json') : ''

function fragment(overrides: Partial<IndexedFragment> & Pick<IndexedFragment, 'id' | 'text' | 'provision'>): IndexedFragment {
  return {
    documentPath: 'DS-HD 60364.pdf',
    documentName: 'DS-HD 60364.pdf',
    documentHash: 'hash',
    physicalPage: 1,
    source: 'native',
    extractionConfidence: 1,
    parserConfidence: 0.98,
    ...overrides
  }
}

describe('DocumentSearch', () => {
  it('maps exam shorthand to the public EV charging SPD provision', () => {
    const search = new DocumentSearch([
      fragment({ id: 'distractor-spd', provision: '534.4.2', text: "Generelle krav til valg og installation af SPD'er." }),
      fragment({ id: 'distractor-public', provision: '718.1', text: 'Et område, der er offentligt tilgængeligt.' }),
      fragment({
        id: 'target',
        physicalPage: 802,
        provision: '722.443.4',
        text: 'Et tilslutningspunkt, som er offentligt tilgængeligt, skal beskyttes mod transiente overspændinger.'
      })
    ])

    const results = search.search('SPD offentlig elbil lader')

    expect(results[0].provision).toBe('722.443.4')
    expect(results[0].physicalPage).toBe(802)
    expect(results[0].confidence).toBeGreaterThanOrEqual(85)
  })

  it('never returns a disabled document, including through truth boosting', () => {
    const target = fragment({
      id: 'target',
      documentPath: 'enabled-or-disabled.pdf',
      documentName: 'DS-HD 60364.pdf',
      physicalPage: 802,
      provision: '722.443.4',
      text: 'Et offentligt tilgængeligt tilslutningspunkt skal beskyttes mod transiente overspændinger.'
    })
    const fallback = fragment({
      id: 'fallback',
      documentPath: 'other.pdf',
      documentName: 'Andet dokument.pdf',
      provision: '1.1',
      text: 'Generel omtale af SPD og ladestandere.'
    })
    const search = new DocumentSearch([target, fallback], [{
      id: '1',
      question: 'Skal en offentlig elbillader beskyttes med SPD?',
      document: 'DS-HD 60364',
      provision: '722.443.4',
      physicalPage: 802,
      answer: 'Ja',
      explanation: '',
      keywords: 'SPD, offentlig, ladestander'
    }])

    const results = search.search('SPD offentlig elbil lader', 20, new Set(['other.pdf']))

    expect(results.map((result) => result.documentPath)).toEqual(['other.pdf'])
  })

  it('requires every quoted phrase even when truth boosting matches', () => {
    const search = new DocumentSearch([
      fragment({ id: 'complete', provision: '1.1', text: 'En CEE-stikkontakt beskyttes med en RCD på 30 mA.' }),
      fragment({ id: 'partial', provision: '1.2', text: 'En CEE-stikkontakt uden den krævede beskyttelse.' })
    ])

    const results = search.search('"CEE-stikkontakt" "30 mA"')

    expect(results.map((result) => result.id)).toEqual(['complete'])
  })

  it('uses the cited legal item instead of boosting every fragment on the physical page', () => {
    const search = new DocumentSearch([
      fragment({ id: 'class-ii', documentName: 'BEK 1082.pdf', documentPath: 'BEK 1082.pdf', physicalPage: 12, provision: '§ 74, stk. 1, nr. 2', text: 'Armaturer eller enkeltdele af klasse II.' }),
      fragment({ id: 'rcd', documentName: 'BEK 1082.pdf', documentPath: 'BEK 1082.pdf', physicalPage: 12, provision: '§ 74, stk. 1, nr. 3', text: 'Supplerende beskyttelse i henhold til § 35 med RCD på højst 30 mA.' })
    ], [{
      id: 'S002',
      question: 'Skal ikke-identiske klasse I-armaturer ved vedligeholdelse RCD-beskyttes?',
      document: 'BEK 1082',
      provision: '§ 74, stk. 1, nr. 3, jf. § 35, stk. 2',
      physicalPage: 12,
      answer: 'Ja.',
      explanation: '',
      keywords: 'vedligeholdelse, klasse I, armaturer, RCD'
    }])

    const results = search.search('vedligeholdelse klasse I armaturer RCD')

    expect(results[0].provision).toBe('§ 74, stk. 1, nr. 3')
  })

  it.runIf(Boolean(storedIndexPath) && existsSync(storedIndexPath))('ranks 722.443.4 first in the complete local index', () => {
    const stored = JSON.parse(readFileSync(storedIndexPath, 'utf8')) as StoredIndex
    const results = new DocumentSearch(stored.fragments).search('SPD offentlig elbil lader')

    expect(results[0].documentName).toContain('DS-HD')
    expect(results[0].physicalPage).toBe(802)
    expect(results[0].provision).toBe('722.443.4')
  })
})
