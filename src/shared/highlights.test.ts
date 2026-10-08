import { describe, expect, it } from 'vitest'
import { containsVisibleInk, locateHighlight } from './highlights'

const items = (values: string[]) => values.map((str) => ({ str }))

describe('locateHighlight', () => {
  it('marks only the typed substring in yellow', () => {
    const result = locateHighlight(items(['Et offentligt tilgængeligt punkt.']), 'offentlig')

    expect(result.kinds).toEqual(['query'])
    expect(result.matches).toEqual([{ index: 0, start: 3, end: 12, kind: 'query' }])
  })

  it('marks configured synonyms in blue without covering typed words', () => {
    const result = locateHighlight(items([
      'Et tilslutningspunkt skal beskyttes mod transiente overspændinger.',
      'SPD anvendes her.'
    ]), 'SPD elbil lader')

    expect(result.kinds).toEqual(['query', 'synonym'])
    expect(result.matches.some((match) => match.kind === 'query' && match.index === 1)).toBe(true)
    expect(result.matches.some((match) => match.kind === 'synonym' && match.index === 0)).toBe(true)
  })

  it('marks an exact phrase across PDF text items', () => {
    const result = locateHighlight(items(['direkte opvarmning', 'på undersiden']), '"direkte opvarmning på undersiden"')

    expect(result.kinds).toEqual(['query'])
    expect(result.matches).toEqual([
      { index: 0, start: 0, end: 18, kind: 'query' },
      { index: 1, start: 0, end: 13, kind: 'query' }
    ])
  })

  it('marks the cited law and standard markers', () => {
    const law = locateHighlight(items([
      '§ 74. Ved reparation eller vedligeholdelse',
      '1) armaturer, der er identiske',
      '2) armaturer af klasse II eller',
      '3) supplerende beskyttelse i henhold til § 35.',
      '§ 75. Verifikation af armaturer.'
    ]), 'armatur', '§ 74, stk. 1, nr. 3')
    const standard = locateHighlight(items(['534.4.5.3 Selektivitet mellem overstrømsbeskyttelsesudstyr']), 'selektivitet', '534.4.5.3')

    expect(law.matches.filter((match) => match.kind === 'provision')).toEqual([
      { index: 0, start: 0, end: 5, kind: 'provision' },
      { index: 3, start: 0, end: 2, kind: 'provision' }
    ])
    expect(law.matches.some((match) => match.index === 4)).toBe(false)
    expect(standard.matches[0]).toEqual({ index: 0, start: 0, end: 9, kind: 'provision' })
  })

  it('rejects blank highlight areas from invisible PDF text layers', () => {
    const blank = new Uint8ClampedArray(4 * 4 * 4).fill(255)
    const visible = blank.slice()
    visible.set([20, 20, 20, 255, 20, 20, 20, 255], 20)

    expect(containsVisibleInk(blank, 4, 4)).toBe(false)
    expect(containsVisibleInk(visible, 4, 4)).toBe(true)
  })

  it('limits terms to the cited subsection and numbered item', () => {
    const result = locateHighlight(items([
      '§ 10. Første stykke med prøveord.',
      'Stk. 2. Andet stykke.',
      '1) målrettet prøveord',
      '2) andet punkt med prøveord',
      'Stk. 3. Senere prøveord.'
    ]), 'prøveord', '§ 10, stk. 2, nr. 1')

    expect(result.matches.filter((match) => match.kind === 'query').map((match) => match.index)).toEqual([2])
  })
})
