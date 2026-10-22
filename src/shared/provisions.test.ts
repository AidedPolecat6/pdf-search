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
