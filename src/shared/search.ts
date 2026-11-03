import MiniSearch from 'minisearch'
import { searchableFragments } from './document-language'
import { normalizeTerm, parseQuery, phraseText, queryTerms } from './normalize'
import type { BenchmarkResult, IndexedFragment, OverviewEntry, SearchResult, TruthRecord } from './types'

interface DomainConcept {
  id: string
  alternatives: string[]
  provisionPrefixes?: string[]
}

const DOMAIN_CONCEPTS: DomainConcept[] = [
  {
    id: 'construction-site',
    alternatives: ['byggeplads', 'byggepladsen', 'byggepladser', 'nedrivningsplads', 'nedrivningspladser'],
    provisionPrefixes: ['704.']
  },
  {
    id: 'swimming-pool',
    alternatives: ['svømmebassin', 'svømmebassinet', 'svømmebassiner', 'svømmebassinerne'],
    provisionPrefixes: ['702.']
  },
  {
    id: 'sauna',
    alternatives: ['sauna', 'saunaer', 'saunarum', 'saunarummet', 'saunakabine', 'saunakabinen'],
    provisionPrefixes: ['703.']
  },
  {
    id: 'marking',
    alternatives: ['opmærkes', 'mærkes', 'opmærkning', 'mærkning', 'markering']
  },
  {
    id: 'residual-current-device',
    alternatives: ['rcd', 'fejlstrømsafbryder', 'fejlstrømsafbryderen', 'fejlstrømsafbrydere', 'fejlstrømsafbryderne']
  },
  {
    id: 'surge-protection',
    alternatives: [
      'spd',
      'overspændingsbeskyttelse',
      'overspændingsafleder',
      'overspænding',
      'overspændinger',
      'transient',
      'transiente'
    ]
  },
  {
    id: 'ev-charging',
    alternatives: [
      'elbil',
      'elbiler',
      'ellader',
      'elbillader',
      'lader',
      'ladere',
      'ladestander',
      'ladestandere',
      'ladepunkt',
      'ladepunkter',
      'tilslutningspunkt',
      'elektrisk køretøj',
      'elektriske køretøjer',
      'ev'
    ],
    provisionPrefixes: ['722.']
  }
]

function conceptsForQuery(query: string): DomainConcept[] {
  return conceptsForTerms(queryTerms(query))
}

function conceptsForTerms(terms: string[]): DomainConcept[] {
  const concepts: DomainConcept[] = []
  const usedDomainConcepts = new Set<string>()

  for (const term of terms) {
    const domainConcept = DOMAIN_CONCEPTS.find((concept) => concept.alternatives.includes(term))
    if (domainConcept) {
      if (!usedDomainConcepts.has(domainConcept.id)) {
        concepts.push(domainConcept)
        usedDomainConcepts.add(domainConcept.id)
      }
    } else {
      concepts.push({ id: `literal:${term}`, alternatives: [term] })
    }
  }
  return concepts
}

export function highlightGroupsForQuery(query: string): { query: string[]; synonyms: string[] } {
  const parsed = parseQuery(query)
  const typedTerms = queryTerms(parsed.unquoted)
  const typed = new Set([...parsed.phrases.map(phraseText), ...typedTerms])
  const synonyms = conceptsForTerms(typedTerms)
    .flatMap((concept) => concept.alternatives)
    .map(phraseText)
    .filter((term) => !typed.has(term))
  return {
    query: Array.from(typed).sort((left, right) => right.length - left.length),
    synonyms: Array.from(new Set(synonyms)).sort((left, right) => right.length - left.length)
  }
}

function semanticKeys(value: string): string[] {
  return conceptsForQuery(value).map((concept) => {
    if (!concept.id.startsWith('literal:')) return concept.id
    const term = concept.alternatives[0]
    return `literal:${term.length >= 6 ? term.slice(0, 6) : term}`
  })
}

function truthSimilarity(query: string, truth: TruthRecord): number {
  const queryKeys = new Set(semanticKeys(query))
  const truthKeys = new Set(semanticKeys(`${truth.question} ${truth.keywords}`))
  const matches = Array.from(queryKeys).filter((key) => truthKeys.has(key)).length
  if (matches < 2) return 0
  const queryWords = new Set(queryTerms(query))
  const truthWords = new Set(queryTerms(`${truth.question} ${truth.keywords}`))
  const wordMatches = Array.from(queryWords).filter((word) => truthWords.has(word)).length
  const queryCoverage = matches / queryKeys.size
  const truthCoverage = matches / Math.min(truthKeys.size, Math.max(queryKeys.size, 1))
  const wordCoverage = wordMatches / queryWords.size
  const score = 0.55 * queryCoverage + 0.2 * truthCoverage + 0.25 * wordCoverage
  return score >= 0.55 ? score : 0
}

function normalizeDocument(value: string): string {
  return value
    .toLocaleLowerCase('da-DK')
    .replace(/æ/g, 'ae')
    .replace(/ø/g, 'oe')
    .replace(/å/g, 'aa')
    .replace(/\.pdf$/i, '')
    .replace(/[^a-z0-9]/g, '')
}

function provisionMatches(result: string, truth: string): boolean {
  const normalize = (value: string) => value
    .toLocaleLowerCase('da-DK')
    .replace(/punkt/g, 'nr')
    .replace(/pkt\.?/g, '')
    .replace(/[^a-zæøå0-9]/g, '')
  const resultValue = normalize(result)
  const truthValue = normalize(truth)
  if (resultValue.includes(truthValue) || truthValue.includes(resultValue)) return true
  const truthNumbers: string[] = truth.match(/\d+/g) ?? []
  const resultNumbers: string[] = result.match(/\d+/g) ?? []
  return truthNumbers.length > 0 && truthNumbers.every((number) => resultNumbers.includes(number))
}

function isTruthTarget(fragment: IndexedFragment, truth: TruthRecord): boolean {
  const resultDocument = normalizeDocument(fragment.documentName)
  const truthDocument = normalizeDocument(truth.document)
  const documentMatches = resultDocument.includes(truthDocument) || truthDocument.includes(resultDocument)
  if (!documentMatches) return false
  if (truth.physicalPage !== null && fragment.physicalPage !== truth.physicalPage) return false
  const primaryProvision = truth.provision.split(/\bjf\./i)[0].trim()
  const standardLocator = primaryProvision.match(/(?:\d+(?:\.(?:\d+|[A-Z]\d*))+|[A-Z]\.\d+(?:\.\d+)*)/i)?.[0]
  if (standardLocator && fragment.text.toLocaleLowerCase('da-DK').includes(standardLocator.toLocaleLowerCase('da-DK'))) return true
  if (/side uden identificeret bestemmelse/i.test(fragment.provision) && truth.physicalPage !== null) return true
  return provisionMatches(fragment.provision, primaryProvision)
}

function alternativeMatcher(alternative: string): (haystack: string) => boolean {
  const normalized = alternative.toLocaleLowerCase('da-DK')
  if (normalized.length > 3 || normalized.includes(' ')) return haystack => haystack.includes(normalized)
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, 'u')
  return haystack => pattern.test(haystack)
}

function overviewByFragment(fragments: IndexedFragment[], entries: OverviewEntry[]): Map<string, string> {
  const result = new Map<string, string>()
  if (!entries.length) return result
  const documents = new Map<string, IndexedFragment[]>()
  for (const fragment of fragments) {
    const key = normalizeDocument(fragment.documentName)
    const group = documents.get(key)
    if (group) group.push(fragment)
    else documents.set(key, [fragment])
  }

  for (const [document, documentFragments] of documents) {
    const matching = entries.filter((entry) => {
      const overviewDocument = normalizeDocument(entry.document)
      return document.includes(overviewDocument) || overviewDocument.includes(document)
    })
    if (!matching.length) continue
    const firstPage = Math.min(...documentFragments.map((fragment) => fragment.physicalPage))
    const sections = matching.flatMap((entry, index) => {
      const label = phraseText(entry.label)
      const inferredPage = documentFragments.find((fragment) => phraseText(fragment.text).includes(label))?.physicalPage
      const startPage = entry.physicalPage ?? inferredPage ?? (index === 0 ? firstPage : null)
      return startPage === null ? [] : [{ ...entry, startPage }]
    }).sort((left, right) => left.startPage - right.startPage)

    for (const fragment of documentFragments) {
      const section = sections.filter((entry) => entry.startPage <= fragment.physicalPage).at(-1)
      if (section) result.set(fragment.id, `${section.label} ${section.title}`)
    }
  }
  return result
}

export class DocumentSearch {
  private readonly fragments = new Map<string, IndexedFragment>()
  private readonly documents = new Map<string, string>()
  private readonly searchTexts = new Map<string, string>()
  private readonly headings = new Map<string, string>()
  private readonly overviews = new Map<string, string>()
  private readonly truths: TruthRecord[]
  private readonly engine = new MiniSearch({
    idField: 'id',
    fields: ['text', 'provision', 'documentName', 'overview', 'heading'],
    storeFields: ['id'],
    processTerm: (term) => normalizeTerm(term)
  })

  constructor(fragments: IndexedFragment[], truths: TruthRecord[] = [], overview: OverviewEntry[] = []) {
    fragments = searchableFragments(fragments)
    this.truths = truths
    this.overviews = overviewByFragment(fragments, overview)
    fragments.forEach((fragment) => {
      this.fragments.set(fragment.id, fragment)
      this.documents.set(fragment.documentPath, normalizeDocument(fragment.documentName))
    })
    const titles = new Map<string, string>()
    for (const fragment of [...fragments].sort((a, b) => a.physicalPage - b.physicalPage)) {
      const clause = fragment.provision.replace(/ \(fortsat\)$/, '')
      if (!/^\d+(?:\.\d+)+$/.test(clause)) continue
      const documentKey = `${fragment.documentPath}:`
      for (const key of titles.keys()) {
        if (key.startsWith(documentKey)) {
          const parent = key.slice(documentKey.length)
          if (clause !== parent && !clause.startsWith(`${parent}.`)) titles.delete(key)
        }
      }
      const parts = clause.split('.')
      const inherited: string[] = []
      while (parts.length > 1) {
        parts.pop()
        const title = titles.get(`${fragment.documentPath}:${parts.join('.')}`)
        if (title) inherited.unshift(title)
      }
      this.headings.set(fragment.id, inherited.join(' '))
      const text = fragment.text.trim()
      // Only standalone headings supply context; parent provisions may contain unrelated requirements.
      if (text.startsWith(`${clause} `) && text.length < 180 && !/[\n.!?…]/.test(text.slice(clause.length))) {
        titles.set(`${fragment.documentPath}:${clause}`, text.slice(clause.length).trim())
      }
    }
    this.engine.addAll(fragments.map((fragment) => {
      const overview = this.overviews.get(fragment.id) ?? ''
      const heading = this.headings.get(fragment.id) ?? ''
      this.searchTexts.set(fragment.id, `${fragment.provision} ${fragment.text} ${overview} ${heading}`.toLocaleLowerCase('da-DK'))
      return { ...fragment, overview, heading }
    }))
  }

  private truthDocumentIsEnabled(truth: TruthRecord, enabledDocumentPaths?: ReadonlySet<string>): boolean {
    const truthDocument = normalizeDocument(truth.document)
    return Array.from(this.documents).some(([path, document]) => {
      if (enabledDocumentPaths && !enabledDocumentPaths.has(path)) return false
      return document.includes(truthDocument) || truthDocument.includes(document)
    })
  }

  search(query: string, limit = 20, enabledDocumentPaths?: ReadonlySet<string>): SearchResult[] {
    const parsed = parseQuery(query)
    if (!parsed.valid) return []
    const unquotedTerms = queryTerms(parsed.unquoted)
    const requestedLaws = Array.from(parsed.unquoted.matchAll(/\b(BEK|LBK)\.?\s*(\d+)\b/gi),
      match => new RegExp(`(?:^|[^a-z0-9])${match[1]}[\\s._-]*${match[2]}(?!\\d)`, 'i'))
    const phraseTerms = queryTerms(parsed.phrases.join(' '))
    const boostText = (text: string): string => phraseText(text).replace(/(\d)\s+(?=\p{L})/gu, '$1')
    const boosted = [...new Set(parsed.boosted.map(boostText))]
    const boostMatchers = boosted.map(text => new RegExp(`(?<![\\p{L}\\p{N}.,])${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'u'))
    const boostTerms = boosted.flatMap(text => queryTerms(`${text} ${text.replace(/(\d)(?=\p{L})/gu, '$1 ')}`))
    const terms = Array.from(new Set([...unquotedTerms, ...phraseTerms, ...boostTerms]))
    if (!terms.length) return []

    const matchedTruth = this.truths
      .filter((truth) => this.truthDocumentIsEnabled(truth, enabledDocumentPaths))
      .map((truth) => ({ truth, similarity: truthSimilarity(query, truth) }))
      .sort((left, right) => right.similarity - left.similarity)[0]
    const truth = matchedTruth?.similarity ? matchedTruth.truth : null
    const acceptedTruths = truth ? this.truths.filter(candidate => candidate.question === truth.question
      && this.truthDocumentIsEnabled(candidate, enabledDocumentPaths)) : []
    const concepts: DomainConcept[] = [
      ...conceptsForTerms(unquotedTerms),
      ...conceptsForTerms(boostTerms),
      ...phraseTerms.map((term) => ({ id: `quoted:${term}`, alternatives: [term] })),
      ...acceptedTruths.flatMap(candidate => conceptsForQuery(`${candidate.question} ${candidate.keywords} ${candidate.provision}`))
    ].filter((concept, index, all) => all.findIndex((candidate) => candidate.id === concept.id) === index)
    const expandedQuery = concepts.flatMap((concept) => concept.alternatives).join(' ')
    const phraseNeedles = parsed.phrases.map(phraseText)
    const conceptMatchers = concepts.map(concept => concept.alternatives.map(alternativeMatcher))
    const exactMatchers = terms.map(alternativeMatcher)
    const scopedConcepts = concepts.filter(concept => concept.provisionPrefixes?.length)

    const raw = this.engine.search(expandedQuery, {
      prefix: (term) => term.length >= 5,
      fuzzy: (term) => term.length >= 7 ? 0.16 : false,
      combineWith: 'OR',
      boost: { provision: 2.4, overview: 1.6, documentName: 1.3, text: 1, heading: 1 }
    }).filter((match) => {
      const fragment = this.fragments.get(String(match.id))
      if (!fragment || (enabledDocumentPaths && !enabledDocumentPaths.has(fragment.documentPath))) return false
      if (!phraseNeedles.length) return true
      const haystack = phraseText(`${fragment.provision} ${fragment.text}`)
      return phraseNeedles.every(phrase => haystack.includes(phrase))
    })
    if (!raw.length) return []

    const conceptCounts = concepts.map(() => 0)
    const candidateConcepts = raw.map(match => {
      const haystack = this.searchTexts.get(String(match.id))!
      return { haystack, hits: conceptMatchers.map((matchers, index) => {
        const matched = matchers.some(matches => matches(haystack))
        if (matched) conceptCounts[index]++
        return matched
      }) }
    })
    const conceptWeights = conceptCounts.map(count => count ? Math.log(1 + raw.length / count) : 1)
    const totalWeight = conceptWeights.reduce((sum, weight) => sum + weight, 0)
    const topScore = raw[0].score
    const ranked = raw.map((match, index) => {
      const fragment = this.fragments.get(String(match.id))!
      const { haystack, hits } = candidateConcepts[index]
      const conceptCoverage = conceptWeights.reduce((sum, weight, i) => sum + (hits[i] ? weight : 0), 0) / totalWeight
      const exactCoverage = exactMatchers.filter(matches => matches(haystack)).length / terms.length
      const sectionAlignment = scopedConcepts.length
        ? scopedConcepts.filter((concept) => /(?:^|\D)60364(?!\d)/.test(fragment.documentName)
          && concept.provisionPrefixes!.some((prefix) => fragment.provision.startsWith(prefix))).length / scopedConcepts.length
        : 1
      const relativeRank = Math.min(1, match.score / topScore)
      const boostCoverage = boostMatchers.length
        ? boostMatchers.filter(pattern => pattern.test(boostText(`${fragment.provision} ${fragment.text}`))).length / boostMatchers.length : 0
      const targetTruth = acceptedTruths.find(candidate => isTruthTarget(fragment, candidate))
      const truthTarget = Boolean(targetTruth)
      const truthLocator = targetTruth?.provision.match(/\d+(?:\.(?:\d+|[A-Z]\d*))+/i)?.[0]
      const confidence = Math.round(100 * (
        0.5 * conceptCoverage +
        0.1 * exactCoverage +
        0.15 * sectionAlignment +
        0.1 * relativeRank +
        0.075 * fragment.extractionConfidence +
        0.075 * fragment.parserConfidence
      ))
      return {
        rank: (conceptCoverage * 100 + sectionAlignment * 20 + exactCoverage * 5 + relativeRank * 100 + boostCoverage * 100
          + (requestedLaws.some(law => law.test(fragment.documentName)) ? 100 : 0)
          + (truthTarget ? 200 * matchedTruth.similarity : 0))
          * (/\.{4,}\s*(?:S)?\d/.test(fragment.text) ? 0.2 : 1),
        result: {
          id: fragment.id,
          documentPath: fragment.documentPath,
          documentName: fragment.documentName.replace(/\.pdf$/i, ''),
          physicalPage: fragment.physicalPage,
          provision: truthLocator ?? fragment.provision,
          confidence: Math.max(1, Math.min(99, truthTarget ? Math.max(confidence, 90 + Math.round(8 * matchedTruth.similarity)) : confidence)),
          source: fragment.source
        } satisfies SearchResult
      }
    })

    return ranked
      .sort((left, right) => right.rank - left.rank || right.result.confidence - left.result.confidence || left.result.id.localeCompare(right.result.id))
      .slice(0, limit)
      .map(({ result }) => result)
  }

  benchmark(records: TruthRecord[] = this.truths): BenchmarkResult {
    let top1 = 0
    let top3 = 0
    const failures: string[] = []
    const groups = new Map<string, TruthRecord[]>()
    for (const truth of records) groups.set(truth.question, [...(groups.get(truth.question) ?? []), truth])
    for (const alternatives of groups.values()) {
      const truth = alternatives[0]
      const results = this.search(truth.question, 10)
      const position = results.findIndex((result) => {
        const fragment = this.fragments.get(result.id)
        return fragment ? alternatives.some(candidate => isTruthTarget(fragment, candidate)) : false
      })
      if (position === 0) top1 += 1
      if (position >= 0 && position < 3) top3 += 1
      else failures.push(truth.id)
    }
    return { total: groups.size, top1, top3, failures }
  }
}
