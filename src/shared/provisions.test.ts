import { describe, expect, it } from 'vitest'
import { segmentPage } from './provisions'

const base = {
  documentPath: 'BEK 1082.pdf',
  documentName: 'BEK 1082.pdf',
  documentHash: 'hash',
  physicalPage: 8,
  source: 'native' as const,
  extractionConfidence: 1
}

describe('segmentPage', () => {
  it('keeps explicitly marked interleaved Danish and English page continuations separate', () => {
    const danish = segmentPage({ ...base, text: '49 (da) DS/EN 60204-1:2018\n8.2.6 Danske krav til beskyttelsesledere' })
    const english = segmentPage({ ...base, previousContext: danish.context,
      text: '– 50 – IEC 60204-1:2016\nEnglish continuation\n9.1.1 Control circuit supply' })
    expect(english.fragments[0].provision).toBe('Side uden identificeret bestemmelse')
    const continued = segmentPage({ ...base, previousContext: english.context,
      text: '50 (da) DS/EN 60204-1:2018\nFortsat beskyttelsesleder.\n8.3 Nye krav' })
    expect(continued.fragments[0].provision).toBe('8.2.6 (fortsat)')
    const nextEnglish = segmentPage({ ...base, previousContext: continued.context,
      text: '– 51 – IEC 60204-1:2016\nContinued control circuit supply' })
    expect(nextEnglish.fragments[0].provision).toBe('9.1.1 (fortsat)')
  })

  it('preserves a new subsection before the next section on a continuation page', () => {
    const result = segmentPage({ ...base, previousContext: { section: '41', subsection: '3' },
      text: 'Stk. 4. Kabler over jorden skal beskyttes.\n§ 42. Markeringsbånd skal være røde.' })
    expect(result.fragments.map(item => item.provision)).toEqual(['§ 41, stk. 4', '§ 42, stk. 1'])
    expect(result.fragments[0].text).toContain('Kabler over jorden')
    expect(new Set(result.fragments.map(item => item.id)).size).toBe(result.fragments.length)
  })

  it('preserves table text before a new standard clause', () => {
    const result = segmentPage({ ...base, previousContext: { standardClause: '712.443.102' },
      text: 'Tabel 712.102 – Beregningsværdier\n35 115\n712.444.1 Næste bestemmelse' })
    expect(result.fragments[0].text).toContain('35 115')
    expect(result.fragments[0].provision).toBe('712.443.102 (fortsat)')
    expect(result.fragments[1].provision).toBe('712.444.1')
  })

  it('updates subsection context even without a new section heading', () => {
    const result = segmentPage({ ...base, previousContext: { section: '56', subsection: '1' },
      text: 'Stk. 2. Andet stykke.\nStk. 4. Fjerde stykke.' })
    expect(result.context.subsection).toBe('4')
    expect(result.fragments.map(item => item.provision)).toEqual(['§ 56, stk. 2', '§ 56, stk. 4'])
  })

  it('labels implicit stk. 1 and numbered items', () => {
    const result = segmentPage({
      ...base,
      text: '§ 45. Der skal være følgende sammenhæng:\n1) For stikkontakter med mærkestrøm på 10 A må beskyttelsen være 13 A.\n2) For 16 A må den være 16 A.\n§ 46. Hospitalsstikkontakter.'
    })

    expect(result.fragments.map((item) => item.provision)).toEqual([
      '§ 45, stk. 1, nr. 1',
      '§ 45, stk. 1, nr. 2',
      '§ 46, stk. 1'
    ])
    expect(result.fragments[0].physicalPage).toBe(8)
  })

  it('inherits a provision on continuation pages', () => {
    const result = segmentPage({
      ...base,
      physicalPage: 9,
      text: 'Fortsættelse af teksten på næste side.',
      previousContext: { section: '45', subsection: '1' }
    })
    expect(result.fragments[0].provision).toBe('§ 45, stk. 1 (fortsat)')
  })

  it('carries the final explicit subsection to the next page', () => {
    const first = segmentPage({
      ...base,
      text: '§ 73. Første stykke.\nStk. 2. Andet stykke fortsætter på næste side.'
    })
    const continuation = segmentPage({
      ...base,
      physicalPage: 9,
      text: 'Den fortsatte tekst uden ny markør.',
      previousContext: first.context
    })
    expect(continuation.fragments[0].provision).toBe('§ 73, stk. 2 (fortsat)')
  })

  it('recognizes standard clauses', () => {
    const result = segmentPage({ ...base, text: '6.2.1 Spændingsløst arbejde\nFem sikkerhedsregler skal følges.' })
    expect(result.fragments[0].provision).toBe('6.2.1')
  })
})
