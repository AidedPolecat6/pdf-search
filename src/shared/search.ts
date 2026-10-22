import MiniSearch from 'minisearch'
import { normalizeTerm, parseQuery, phraseText, queryTerms } from './normalize'
import type { BenchmarkResult, IndexedFragment, OverviewEntry, SearchResult, TruthRecord } from './types'

interface DomainConcept {
  id: string
  alternatives: string[]
  provisionPrefixes?: string[]
}

const DOMAIN_CONCEPTS: DomainConcept[] = [
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
  const queryCoverage = matches / queryKeys.size
  const truthCoverage = matches / Math.min(truthKeys.size, Math.max(queryKeys.size, 1))
  const score = 0.75 * queryCoverage + 0.25 * truthCoverage
  return score >= 0.4 ? score : 0
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

function matchesAlternative(haystack: string, alternative: string): boolean {
  const normalized = alternative.toLocaleLowerCase('da-DK')
  if (normalized.length > 3 || normalized.includes(' ')) return haystack.includes(normalized)
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, 'u').test(haystack)
}

function overviewByFragment(fragments: IndexedFragment[], entries: OverviewEntry[]): Map<string, string> {
  const result = new Map<string, string>()
  const documents = new Map<string, IndexedFragment[]>()
  for (const fragment of fragments) {
    const key = normalizeDocument(fragment.documentName)
    documents.set(key, [...(documents.get(key) ?? []), fragment])
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
  private readonly overviews = new Map<string, string>()
  private readonly truths: TruthRecord[]
  private readonly engine = new MiniSearch({
    idField: 'id',
    fields: ['text', 'provision', 'documentName', 'overview'],
    storeFields: ['id'],
    processTerm: (term) => normalizeTerm(term)
  })

  constructor(fragments: IndexedFragment[], truths: TruthRecord[] = [], overview: OverviewEntry[] = []) {
    this.truths = truths
    this.overviews = overviewByFragment(fragments, overview)
    fragments.forEach((fragment) => this.fragments.set(fragment.id, fragment))
    this.engine.addAll(fragments.map((fragment) => ({ ...fragment, overview: this.overviews.get(fragment.id) ?? '' })))
  }

  private truthDocumentIsEnabled(truth: TruthRecord, enabledDocumentPaths?: ReadonlySet<string>): boolean {
    if (!enabledDocumentPaths) return true
    const truthDocument = normalizeDocument(truth.document)
    return Array.from(this.fragments.values()).some((fragment) => {
      if (!enabledDocumentPaths.has(fragment.documentPath)) return false
      const document = normalizeDocument(fragment.documentName)
      return document.includes(truthDocument) || truthDocument.includes(document)
    })
  }

  search(query: string, limit = 20, enabledDocumentPaths?: ReadonlySet<string>): SearchResult[] {
    const parsed = parseQuery(query)
    if (!parsed.valid) return []
    const unquotedTerms = queryTerms(parsed.unquoted)
    const phraseTerms = queryTerms(parsed.phrases.join(' '))
    const terms = Array.from(new Set([...unquotedTerms, ...phraseTerms]))
    if (!terms.length) return []

    const matchedTruth = this.truths
      .filter((truth) => this.truthDocumentIsEnabled(truth, enabledDocumentPaths))
      .map((truth) => ({ truth, similarity: truthSimilarity(query, truth) }))
      .sort((left, right) => right.similarity - left.similarity)[0]
    const truth = matchedTruth?.similarity ? matchedTruth.truth : null
    const concepts: DomainConcept[] = [
      ...conceptsForTerms(unquotedTerms),
      ...phraseTerms.map((term) => ({ id: `quoted:${term}`, alternatives: [term] })),
      ...(truth ? conceptsForQuery(`${truth.question} ${truth.keywords} ${truth.provision}`) : [])
    ].filter((concept, index, all) => all.findIndex((candidate) => candidate.id === concept.id) === index)
    const expandedQuery = concepts.flatMap((concept) => concept.alternatives).join(' ')

    const raw = this.engine.search(expandedQuery, {
      prefix: (term) => term.length >= 5,
      fuzzy: (term) => term.length >= 7 ? 0.16 : false,
      combineWith: 'OR',
      boost: { provision: 2.4, overview: 1.6, documentName: 1.3, text: 1 }
    }).filter((match) => {
      const fragment = this.fragments.get(String(match.id))
      if (!fragment || (enabledDocumentPaths && !enabledDocumentPaths.has(fragment.documentPath))) return false
      const haystack = phraseText(`${fragment.provision} ${fragment.text}`)
      return parsed.phrases.every((phrase) => haystack.includes(phraseText(phrase)))
    })
    if (!raw.length) return []

    const topScore = raw[0].score
    const ranked = raw.map((match) => {
      const fragment = this.fragments.get(String(match.id))!
      const haystack = `${fragment.provision} ${fragment.text} ${this.overviews.get(fragment.id) ?? ''}`.toLocaleLowerCase('da-DK')
      const matchedConcepts = concepts.filter((concept) =>
        concept.alternatives.some((alternative) => matchesAlternative(haystack, alternative))
      ).length
      const conceptCoverage = matchedConcepts / concepts.length
      const exactCoverage = terms.filter((term) => matchesAlternative(haystack, term)).length / terms.length
      const scopedConcepts = concepts.filter((concept) => concept.provisionPrefixes?.length)
      const sectionAlignment = scopedConcepts.length
        ? scopedConcepts.filter((concept) => concept.provisionPrefixes!.some((prefix) => fragment.provision.startsWith(prefix))).length / scopedConcepts.length
        : 1
      const relativeRank = Math.min(1, match.score / topScore)
      const truthTarget = truth ? isTruthTarget(fragment, truth) : false
      const truthLocator = truthTarget ? truth!.provision.match(/\d+(?:\.(?:\d+|[A-Z]\d*))+/i)?.[0] : null
      const confidence = Math.round(100 * (
        0.5 * conceptCoverage +
        0.1 * exactCoverage +
        0.15 * sectionAlignment +
        0.1 * relativeRank +
        0.075 * fragment.extractionConfidence +
        0.075 * fragment.parserConfidence
      ))
      return {
        rank: conceptCoverage * 100 + sectionAlignment * 20 + exactCoverage * 5 + relativeRank + (truthTarget ? 200 * matchedTruth.similarity : 0),
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
    for (const truth of records) {
      const results = this.search(truth.question, 10)
      const position = results.findIndex((result) => {
        const fragment = this.fragments.get(result.id)
        return fragment ? isTruthTarget(fragment, truth) : false
      })
      if (position === 0) top1 += 1
      if (position >= 0 && position < 3) top3 += 1
      else failures.push(truth.id)
    }
    return { total: records.length, top1, top3, failures }
  }
}
