import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DocumentSearch, highlightGroupsForQuery } from './search'
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
  it('prioritizes whole starred expressions without making them mandatory', () => {
    const search = new DocumentSearch([
      fragment({ id: 'wrong', provision: '1.1', text: 'Byggeplads stikkontakt 63 A.' }),
      fragment({ id: 'spaced', provision: '1.2', text: 'Byggeplads stikkontakt 16 A.' }),
      fragment({ id: 'compact', provision: '1.3', text: 'Byggeplads stikkontakt 16A.' }),
      fragment({ id: 'substring', provision: '1.4', text: 'Byggeplads stikkontakt 116 A.' }),
      fragment({ id: 'split', provision: '1.5', text: 'Byggeplads stikkontakt 16 V og 63 A.' })
    ])
    for (const query of ['byggeplads stikkontakt *16 A*', 'byggeplads stikkontakt *16A*']) {
      const results = search.search(query)
      expect(new Set(results.slice(0, 2).map(r => r.id))).toEqual(new Set(['spaced', 'compact']))
      expect(results.map(r => r.id)).toContain('wrong')
    }
    expect(new Set(search.search('*16 A*').map(r => r.id))).toContain('compact')
    expect(search.search('byggeplads *16 A* "63 A"').every(r => ['wrong','split'].includes(r.id))).toBe(true)
    expect(search.search('byggeplads *16 A')).toEqual([])
    expect(search.search('byggeplads *16 A*', 20, new Set(['other.pdf']))).toEqual([])
  })

  it('boosts a word without matching it inside a longer word', () => {
    const search = new DocumentSearch([
      fragment({ id: 'target', provision: '1.1', text: 'Motor beskyttelse sauna.' }),
      fragment({ id: 'other', provision: '1.2', text: 'Motor beskyttelse.' })
    ])
    expect(search.search('motor beskyttelse *sauna*')[0].id).toBe('target')
    expect(search.search('motor beskyttelse *ukendt*')).toHaveLength(2)
  })
  it('uses alternative references for the same question without bypassing document and phrase filters', () => {
    const question = 'Hvordan beskyttes motorer mod overbelastning?'
    const truths = ['1.1', '2.2'].map((provision, i) => ({ id: String(i), question,
      document: 'DS-HD 60364', provision, physicalPage: 1, answer: '', explanation: '', keywords: '' }))
    const search = new DocumentSearch([
      fragment({ id: 'first', provision: '1.1', text: '1.1 Beskyttelse af motorer.' }),
      fragment({ id: 'alternative', provision: '2.2', text: '2.2 Overbelastning skal afbrydes.' }),
      fragment({ id: 'unrelated', provision: '3.3', text: 'Motorer overbelastning beskyttes motorer.' })
    ], truths)
    expect(new Set(search.search(question, 2).map(r => r.id))).toEqual(new Set(['first', 'alternative']))
    expect(search.benchmark()).toEqual({ total: 1, top1: 1, top3: 1, failures: [] })
    expect(search.search(question, 20, new Set(['disabled.pdf']))).toEqual([])
    expect(search.search(`${question} "skal afbrydes"`).map(r => r.id)).toEqual(['alternative'])
  })
  it('keeps rarity weighting finite when retrieval finds only a spelling variant', () => {
    const search = new DocumentSearch([
      fragment({ id: 'target', provision: '1.1', text: 'Termistorbeskyttelse af motorer.' })
    ])
    const results = search.search('termistorbeskyttlse ukendtfagudtryk')
    expect(results[0].id).toBe('target')
    expect(Number.isFinite(results[0].confidence)).toBe(true)
    expect(results[0].confidence).toBeGreaterThan(0)
    expect(results[0].confidence).toBeLessThan(100)
  })

  it.each([
    ['saunarum', '703.1'], ['byggeplads', '704.1'], ['svømmebassin', '702.1']
  ])('prefers the relevant installation section for %s without borrowing numbering from other standards', (term, provision) => {
    const text = `${term} kræver beskyttelse.`
    const search = new DocumentSearch([
      fragment({ id: 'a-unrelated', documentName: 'Anden standard.pdf', documentPath: 'other.pdf', provision, text }),
      fragment({ id: 'general', provision: '1.1', text }),
      fragment({ id: 'target', provision, text })
    ])
    expect(search.search(`${term} beskyttelse`)[0].id).toBe('target')
    expect(search.search(`${term} beskyttelse`, 10, new Set(['other.pdf'])).map(result => result.id)).toEqual(['a-unrelated'])
    expect(search.search(`${term} "findes ikke"`)).toEqual([])
  })

  it('matches Danish marking terms while preserving literal quotes and synonym highlighting', () => {
    const search = new DocumentSearch([
      fragment({ id: 'mark', provision: '1.1', text: 'Klemmer mærkes tydeligt.' }),
      fragment({ id: 'label', provision: '1.2', text: 'Klemmer opmærkes tydeligt.' }),
      fragment({ id: 'other', provision: '1.3', text: 'Klemmer skal spændes.' })
    ])
    for (const query of ['mærkes', 'opmærkes', 'opmærkning', 'mærkning', 'markering']) {
      expect(search.search(query, 2).map(result => result.id).sort()).toEqual(['label', 'mark'])
    }
    expect(search.search('"opmærkes"').map(result => result.id)).toEqual(['label'])
    expect(highlightGroupsForQuery('opmærkes').synonyms).toContain('mærkes')
    expect(highlightGroupsForQuery('"opmærkes"').synonyms).toEqual([])
  })

  it('excludes English publications even through quoted search and truth boosting', () => {
    const search = new DocumentSearch([
      fragment({ id: 'metadata', documentPath: 'english.pdf', documentName: 'English standard.pdf',
        provision: 'Side uden identificeret bestemmelse', text: 'DS-publikationen er på engelsk.' }),
      fragment({ id: 'english', documentPath: 'english.pdf', documentName: 'English standard.pdf', physicalPage: 10,
        provision: '1.1', text: 'Earth electrodes shall resist corrosion.' }),
      fragment({ id: 'danish', provision: '1.1', text: 'Jordelektroder skal modstå korrosion.' })
    ], [{ id: 'truth', question: 'Earth electrodes corrosion', document: 'English standard', provision: '1.1',
      physicalPage: 10, answer: '', explanation: '', keywords: '' }])
    expect(search.search('Earth electrodes corrosion').every(result => result.documentPath !== 'english.pdf')).toBe(true)
    expect(search.search('"Earth electrodes"')).toEqual([])
    expect(search.search('jordelektroder')[0].id).toBe('danish')
  })
  it('matches RCD and fejlstrømsafbryder in both directions while keeping quoted searches literal', () => {
    const search = new DocumentSearch([
      fragment({ id: 'abbreviation', provision: '1.1', text: 'RCD skal kontrolleres.' }),
      fragment({ id: 'danish', provision: '1.2', text: 'Fejlstrømsafbryderen skal kontrolleres.' }),
      fragment({ id: 'other', provision: '1.3', text: 'En maksimalafbryder skal kontrolleres.' })
    ])
    for (const query of ['RCD', 'fejlstrømsafbryder', 'fejlstrømsafbryderen']) {
      expect(search.search(query).map(result => result.id).sort()).toEqual(['abbreviation', 'danish'])
    }
    expect(search.search('"RCD"').map(result => result.id)).toEqual(['abbreviation'])
    expect(search.search('"fejlstrømsafbryderen"').map(result => result.id)).toEqual(['danish'])
    expect(highlightGroupsForQuery('RCD').synonyms).toContain('fejlstrømsafbryderen')
    expect(highlightGroupsForQuery('"RCD"').synonyms).toEqual([])
  })

  it('prefers an explicitly requested law over a copy, respecting document filters and quotes', () => {
    const search = new DocumentSearch([
      fragment({ id: 'copy', documentPath: 'copy.pdf', documentName: 'Standard.pdf', provision: '1.1',
        text: 'BEK 123 Kabler skal beskyttes. Kopiens ordlyd.' }),
      fragment({ id: 'law', documentPath: 'law.pdf', documentName: 'BEK 123 Installation.pdf', provision: '§ 1',
        text: 'Kabler skal beskyttes.' }),
      fragment({ id: 'other-number', documentPath: 'other.pdf', documentName: 'BEK 1234.pdf', provision: '§ 1',
        text: 'BEK 123 Kabler skal beskyttes.' })
    ])
    expect(search.search('Bek.123 kabler beskyttes')[0].id).toBe('law')
    expect(search.search('Bek.123 kabler beskyttes', 10, new Set(['copy.pdf'])).map(r => r.id)).toEqual(['copy'])
    expect(search.search('Bek.123 "Kopiens ordlyd"').map(r => r.id)).toEqual(['copy'])
    expect(search.search('"BEK 123"').map(r => r.id)).not.toContain('law')
  })

  it('uses parent headings across pages without leaking them into quoted matches or other documents', () => {
    const search = new DocumentSearch([
      fragment({ id: 'heading', provision: '12.3', text: '12.3 Supplerende udligning' }),
      fragment({ id: 'child', physicalPage: 2, provision: '12.3.1', text: '12.3.1 Ledningsevnen svarer til halvdelen.' }),
      fragment({ id: 'sibling', physicalPage: 2, provision: '12.30.1', text: '12.30.1 Andre krav.' }),
      fragment({ id: 'other', documentPath: 'other.pdf', provision: '12.3.1', text: '12.3.1 Andre krav.' })
    ])
    expect(search.search('supplerende udligning halvdelen')[0].id).toBe('child')
    expect(search.search('supplerende').map(r => r.id).sort()).toEqual(['child', 'heading'])
    expect(search.search('"supplerende udligning"').map(r => r.id)).toEqual(['heading'])
  })

  it('does not inherit contents entries, parent body text or headings from an earlier numbering sequence', () => {
    const search = new DocumentSearch([
      fragment({ id: 'heading', provision: '12.3', text: '12.3 Supplerende udligning' }),
      fragment({ id: 'next', provision: '13.1', text: '13.1 Andre regler' }),
      fragment({ id: 'repeated', provision: '12.3.1', text: '12.3.1 Ny nummerering.' }),
      fragment({ id: 'contents', provision: '14.1', text: '14.1 Termistorbeskyttelse ........ 20' }),
      fragment({ id: 'contents-child', provision: '14.1.1', text: '14.1.1 Krav.' }),
      fragment({ id: 'body', provision: '15.1', text: '15.1 Motorbeskyttelse skal tilsluttes korrekt.' }),
      fragment({ id: 'body-child', provision: '15.1.1', text: '15.1.1 Krav.' })
    ])
    expect(search.search('supplerende').map(r => r.id)).toEqual(['heading'])
    expect(search.search('termistorbeskyttelse').map(r => r.id)).toEqual(['contents'])
    expect(search.search('motorbeskyttelse').map(r => r.id)).toEqual(['body'])
  })

  it('prefers substantive text over a contents entry without removing quoted matches', () => {
    const search = new DocumentSearch([
      fragment({ id: 'contents', provision: '1.1', text: 'Termistorbeskyttelse motorer installation kontrol ................ 25' }),
      fragment({ id: 'symbol-index', provision: '2.11', text: 'Termistorbeskyttelse motorer installation kontrol ................ S00448' }),
      fragment({ id: 'body', provision: '1.1', text: 'Termistorbeskyttelse motorer installation kontrol. Beskyttelsen tilsluttes efter producentens anvisninger.' })
    ])
    expect(search.search('Termistorbeskyttelse motorer installation kontrol')[0].id).toBe('body')
    expect(search.search('"................ 25"').map(r => r.id)).toEqual(['contents'])
    expect(search.search('"................ S00448"').map(r => r.id)).toEqual(['symbol-index'])
  })

  it('lets a distinctive technical term outweigh extra generic word matches', () => {
    const search = new DocumentSearch([
      fragment({ id: 'specific', provision: '1.1', text: 'Termistorbeskyttelse for motorer.' }),
      fragment({ id: 'general', provision: '1.2', text: 'Installation motorer kontrol vedligeholdelse.' }),
      ...Array.from({ length: 20 }, (_, i) => fragment({ id: `background-${i}`, provision: '2.1',
        text: 'Installation motorer kontrol vedligeholdelse almindelige krav.' }))
    ])
    expect(search.search('Termistorbeskyttelse motorer installation kontrol')[0].id).toBe('specific')
  })

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

  it('does not boost a truth that only shares generic cable terms', () => {
    const search = new DocumentSearch([
      fragment({ id: 'multiple-circuits', physicalPage: 265, provision: '521.7', text: 'Flere strømkredse må fremføres i samme kabel, når alle ledere er isoleret for den højeste spænding.' }),
      fragment({ id: 'minimum-size', physicalPage: 273, provision: '524.1', text: 'Minimumstværsnit for kobberledere i faste effekt- og belysningskredse er 1,5 mm².' })
    ], [{
      id: 'S012',
      question: 'Hvilket minimumstværsnit skal anvendes til en fast strømkreds med kobberledere?',
      document: 'DS-HD 60364',
      provision: '524.1',
      physicalPage: 273,
      answer: '1,5 mm².',
      explanation: '',
      keywords: 'fast installation, effekt, belysning, kobberleder, minimumstværsnit'
    }])

    expect(search.search('Må flere forskellige strømkredse fremføres i samme kobberkabel?')[0].provision).toBe('521.7')
  })

  it.runIf(Boolean(storedIndexPath) && existsSync(storedIndexPath))('ranks 722.443.4 first in the complete local index', () => {
    const stored = JSON.parse(readFileSync(storedIndexPath, 'utf8')) as StoredIndex
    const results = new DocumentSearch(stored.fragments).search('SPD offentlig elbil lader')

    expect(results[0].documentName).toContain('DS-HD')
    expect(results[0].physicalPage).toBe(802)
    expect(results[0].provision).toBe('722.443.4')
  })

  it('uses local chapter overview titles as searchable metadata', () => {
    const engine = new DocumentSearch([
      fragment({ id: 'general', documentName: 'DS-HD 60364.pdf', documentPath: 'DS-HD 60364.pdf', physicalPage: 100, provision: '6.1', text: 'Generelle krav til verifikation.' }),
      fragment({ id: 'special', documentName: 'DS-HD 60364.pdf', documentPath: 'DS-HD 60364.pdf', physicalPage: 200, provision: '999.1', text: 'Særlige installationer og områder.' })
    ], [], [
      { document: 'DS/HD 60364', label: 'Del 7-999', title: 'Prøveanlæg specialområde', physicalPage: 200 }
    ])

    expect(engine.search('prøveanlæg')[0].id).toBe('special')
  })
})
