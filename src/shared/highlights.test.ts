import { describe, expect, it } from 'vitest'
import { locateHighlight } from './highlights'

const items = (values: string[]) => values.map((str) => ({ str }))

describe('locateHighlight', () => {
  it('marks only the typed substring in yellow', () => {
    const result = locateHighlight(items(['Et offentligt tilgængeligt punkt.']), 'offentlig')

    expect(result.kind).toBe('query')
    expect(result.matches).toEqual([{ index: 0, start: 3, end: 12, kind: 'query' }])
  })

  it('marks configured synonyms in blue without covering typed words', () => {
    const result = locateHighlight(items([
      'Et tilslutningspunkt skal beskyttes mod transiente overspændinger.',
      'SPD anvendes her.'
    ]), 'SPD elbil lader')

    expect(result.kind).toBe('mixed')
    expect(result.matches.some((match) => match.kind === 'query' && match.index === 1)).toBe(true)
    expect(result.matches.some((match) => match.kind === 'synonym' && match.index === 0)).toBe(true)
  })

  it('marks an exact phrase across PDF text items', () => {
    const result = locateHighlight(items(['direkte opvarmning', 'på undersiden']), '"direkte opvarmning på undersiden"')

    expect(result.kind).toBe('query')
    expect(result.matches).toEqual([
      { index: 0, start: 0, end: 18, kind: 'query' },
      { index: 1, start: 0, end: 13, kind: 'query' }
    ])
  })
})
