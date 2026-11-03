import { expect, test } from 'vitest'
import { searchableFragments } from './document-language'
import type { IndexedFragment } from './types'

const fragment = (id: string, documentPath: string, physicalPage: number, text: string) =>
  ({ id, documentPath, physicalPage, text } as IndexedFragment)

test('excludes all pages of English publications including Danish covers and numeric tables', () => {
  const fragments = [fragment('cover', 'english', 1, 'Dansk standard'),
    fragment('metadata', 'english', 2, 'DS-publikationen er på\nengelsk.'),
    fragment('table', 'english', 10, '1 2 3 4'), fragment('danish', 'danish', 1, 'Danske regler')]
  expect(searchableFragments(fragments).map(f => f.id)).toEqual(['danish'])
})

test('retains entire marked Danish pages of bilingual documents and no English counterpart', () => {
  const fragments = [fragment('metadata', 'mixed', 2, 'DS-publikationen er på dansk og engelsk.'),
    fragment('en', 'mixed', 12, '– 4 – IEC 12345:2020\nEnglish text'),
    fragment('da-header', 'mixed', 13, '4 (da) DS/EN 12345:2020'),
    fragment('da-body', 'mixed', 13, 'Dansk tekst'),
    fragment('front', 'mixed', 3, 'English foreword')]
  expect(searchableFragments(fragments).map(f => f.id)).toEqual(['da-header', 'da-body'])
})
