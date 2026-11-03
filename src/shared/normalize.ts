const STOP_WORDS = new Set([
  'af', 'at', 'de', 'den', 'der', 'det', 'du', 'en', 'er', 'et', 'for', 'fra',
  'hvad', 'i', 'ikke', 'kan', 'med', 'og', 'om', 'på', 'skal', 'som', 'til',
  'ved', 'være'
])

export function normalizeText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/\u00ad/g, '')
    .replace(/([\p{L}æøå])[-‐]\s*\n\s*([\p{Ll}æøå])/gu, '$1$2')
    .replace(/\u0000/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function normalizeTerm(term: string): string | null {
  const normalized = term.toLocaleLowerCase('da-DK').replace(/^[^\p{L}\p{N}_]+|[^\p{L}\p{N}_]+$/gu, '')
  if (normalized.length < 2 || STOP_WORDS.has(normalized)) return null
  return normalized
}

export function queryTerms(query: string): string[] {
  return Array.from(new Set(
    normalizeText(query)
      .split(/[^\p{L}\p{N}§]+/u)
      .map(normalizeTerm)
      .filter((term): term is string => Boolean(term))
  ))
}

export interface ParsedQuery {
  unquoted: string
  phrases: string[]
  boosted: string[]
  valid: boolean
}

export function parseQuery(query: string): ParsedQuery {
  const normalized = normalizeText(query).replace(/[“”]/g, '"')
  const phrases: string[] = []
  const boosted: string[] = []
  let boost = ''
  let boosting = false
  let unquoted = ''
  let phrase = ''
  let quoted = false

  for (const character of normalized) {
    if (character === '*' && !quoted) {
      if (boosting && boost.trim()) boosted.push(boost.trim())
      boosting = !boosting
      boost = ''
      unquoted += ' '
    } else if (character === '"') {
      if (boosting) return { unquoted, phrases, boosted, valid: false }
      if (quoted && phrase.trim()) phrases.push(phrase.replace(/\s+/g, ' ').trim())
      quoted = !quoted
      phrase = ''
      unquoted += ' '
    } else if (quoted) {
      phrase += character
    } else {
      unquoted += character
      if (boosting) boost += character
    }
  }

  return { unquoted: unquoted.replace(/\s+/g, ' ').trim(), phrases, boosted, valid: !quoted && !boosting }
}

export function phraseText(value: string): string {
  return normalizeText(value).toLocaleLowerCase('da-DK').replace(/\s+/g, ' ').trim()
}
