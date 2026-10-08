import { highlightGroupsForQuery } from './search'

export interface HighlightTextItem {
  str: string
}

export interface HighlightMatch {
  index: number
  start: number
  end: number
  kind: 'query' | 'synonym' | 'provision'
}

export interface HighlightSelection {
  matches: HighlightMatch[]
  kinds: HighlightMatch['kind'][]
}

interface CharacterReference {
  index: number
  offset: number
}

interface ProvisionSelection {
  matches: HighlightMatch[]
  scopes: Array<{ start: number; end: number }>
}

function searchableText(items: HighlightTextItem[]): { text: string; references: Array<CharacterReference | null> } {
  let text = ''
  const references: Array<CharacterReference | null> = []

  const appendSpace = (): void => {
    if (text && !text.endsWith(' ')) {
      text += ' '
      references.push(null)
    }
  }

  items.forEach((item, index) => {
    appendSpace()
    for (let offset = 0; offset < item.str.length; offset += 1) {
      const character = item.str[offset]
      if (/\s/u.test(character)) {
        appendSpace()
      } else if (character !== '\u00ad') {
        text += character.toLocaleLowerCase('da-DK')
        references.push({ index, offset })
      }
    }
  })
  return { text, references }
}

function rangesForTerm(
  term: string,
  kind: HighlightMatch['kind'],
  text: string,
  references: Array<CharacterReference | null>
): HighlightMatch[] {
  const matches: HighlightMatch[] = []
  let position = text.indexOf(term)
  while (position >= 0) {
    const byItem = new Map<number, { start: number; end: number }>()
    for (let offset = position; offset < position + term.length; offset += 1) {
      const reference = references[offset]
      if (!reference) continue
      const range = byItem.get(reference.index)
      if (range) range.end = reference.offset + 1
      else byItem.set(reference.index, { start: reference.offset, end: reference.offset + 1 })
    }
    for (const [index, range] of byItem) matches.push({ index, ...range, kind })
    position = text.indexOf(term, position + Math.max(1, term.length))
  }
  return matches
}

function markerMatch(index: number, value: string, expression: RegExp): HighlightMatch | null {
  const match = value.match(expression)
  const marker = match?.[1]
  if (!match || !marker) return null
  const start = (match.index ?? 0) + match[0].indexOf(marker)
  return { index, start, end: start + marker.length, kind: 'provision' }
}

function provisionRanges(items: HighlightTextItem[], provision: string): ProvisionSelection {
  const primary = provision.split(/\bjf\./i)[0].replace(/\s*\(fortsat\)\s*$/i, '').trim()
  const section = primary.match(/§\s*(\d+[a-z]?)/i)?.[1]
  if (section) {
    const sectionPattern = new RegExp(`^\\s*(§\\s*${section}\\b\\.?)`, 'i')
    const sectionIndex = items.findIndex((item) => sectionPattern.test(item.str))
    if (sectionIndex < 0) return { matches: [], scopes: [] }
    const nextSection = items.findIndex((item, index) => index > sectionIndex && /^\s*§\s*\d/i.test(item.str))
    let scopeStart = sectionIndex
    let scopeEnd = nextSection < 0 ? items.length : nextSection
    const matches = [markerMatch(sectionIndex, items[sectionIndex].str, sectionPattern)].filter((match): match is HighlightMatch => Boolean(match))

    const subsection = primary.match(/\bstk\.\s*(\d+)/i)?.[1]
    if (subsection) {
      const subsectionPattern = new RegExp(`^\\s*(Stk\\.\\s*${subsection}\\b\\.?)`, 'i')
      const subsectionOffset = items.slice(sectionIndex + 1, scopeEnd).findIndex((item) => subsectionPattern.test(item.str))
      if (subsectionOffset >= 0) {
        const subsectionIndex = sectionIndex + 1 + subsectionOffset
        const subsectionMatch = markerMatch(subsectionIndex, items[subsectionIndex].str, subsectionPattern)
        if (subsectionMatch) matches.push(subsectionMatch)
        scopeStart = subsectionIndex
        const nextSubsection = items.findIndex((item, index) => index > subsectionIndex && index < scopeEnd && /^\s*Stk\.\s*\d/i.test(item.str))
        scopeEnd = nextSubsection < 0 ? scopeEnd : nextSubsection
      } else if (subsection === '1') {
        const nextSubsection = items.findIndex((item, index) => index > sectionIndex && index < scopeEnd && /^\s*Stk\.\s*\d/i.test(item.str))
        scopeEnd = nextSubsection < 0 ? scopeEnd : nextSubsection
      }
    }

    const item = primary.match(/\bnr\.\s*(\d+)/i)?.[1]
    let itemIndex = -1
    if (item) {
      const itemPattern = new RegExp(`^\\s*((?:Nr\\.\\s*)?${item}(?:\\)|\\.))`, 'i')
      itemIndex = items.findIndex((candidate, index) => index >= scopeStart && index < scopeEnd && itemPattern.test(candidate.str))
      if (itemIndex >= 0) {
        const itemMatch = markerMatch(itemIndex, items[itemIndex].str, itemPattern)
        if (itemMatch) matches.push(itemMatch)
      }
    }
    if (itemIndex < 0) return { matches, scopes: [{ start: scopeStart, end: scopeEnd }] }
    const firstItem = items.findIndex((candidate, index) => index >= scopeStart && index < itemIndex && /^\s*(?:Nr\.\s*)?\d+(?:\)|\.)/i.test(candidate.str))
    const introEnd = firstItem < 0 ? itemIndex : firstItem
    const nextItem = items.findIndex((candidate, index) => index > itemIndex && index < scopeEnd && /^\s*(?:Nr\.\s*)?\d+(?:\)|\.)/i.test(candidate.str))
    return {
      matches,
      scopes: [
        { start: scopeStart, end: introEnd },
        { start: itemIndex, end: nextItem < 0 ? scopeEnd : nextItem }
      ].filter((scope, index, all) => all.findIndex((candidate) => candidate.start === scope.start && candidate.end === scope.end) === index)
    }
  }

  const locator = primary.match(/(?:\d+(?:\.(?:\d+|[A-Z]\d*))+|[A-Z]\.\d+(?:\.\d+)*)/i)?.[0]
  if (!locator) return { matches: [], scopes: [] }
  const escaped = locator.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const locatorPattern = new RegExp(`^\\s*(?:(?:tabel|table)\\s+)?(${escaped}\\b)`, 'i')
  const matches = items.flatMap((item, index) => {
    const match = markerMatch(index, item.str, locatorPattern)
    return match ? [match] : []
  })
  const clausePattern = /^\s*(?:\d+(?:\.\d+)+|[A-Z]\.\d+)\b/i
  const scopes = matches.map((match) => {
    const next = items.findIndex((item, index) => index > match.index && clausePattern.test(item.str))
    return { start: match.index, end: next < 0 ? items.length : next }
  })
  return { matches, scopes }
}

export function containsVisibleInk(data: Uint8ClampedArray, width: number, height: number): boolean {
  if (!width || !height || data.length < width * height * 4) return false
  const colors = new Map<number, number>()
  for (let offset = 0; offset < data.length; offset += 4) {
    const color = (data[offset] >> 4) << 8 | (data[offset + 1] >> 4) << 4 | data[offset + 2] >> 4
    colors.set(color, (colors.get(color) ?? 0) + 1)
  }
  const dominant = Array.from(colors).sort((left, right) => right[1] - left[1])[0][0]
  const background = [dominant >> 8, dominant >> 4 & 15, dominant & 15].map((channel) => channel * 16 + 7)
  let contrasting = 0
  for (let offset = 0; offset < data.length; offset += 4) {
    if (Math.max(
      Math.abs(data[offset] - background[0]),
      Math.abs(data[offset + 1] - background[1]),
      Math.abs(data[offset + 2] - background[2])
    ) >= 32) contrasting += 1
  }
  return contrasting >= Math.max(2, Math.ceil(width * height * 0.005))
}

export function locateHighlight(items: HighlightTextItem[], query: string, provision = ''): HighlightSelection {
  const groups = highlightGroupsForQuery(query)
  const searchable = searchableText(items)
  const provisionSelection = provisionRanges(items, provision)
  const provisionMatches = provisionSelection.matches
  const inProvision = (match: HighlightMatch): boolean => !provisionSelection.scopes.length || provisionSelection.scopes.some((scope) =>
    match.index >= scope.start && match.index < scope.end
  )
  const queryMatches = groups.query.flatMap((term) => rangesForTerm(term, 'query', searchable.text, searchable.references))
    .filter(inProvision)
    .filter((queryMatch) => !provisionMatches.some((provisionMatch) =>
      provisionMatch.index === queryMatch.index && provisionMatch.start < queryMatch.end && queryMatch.start < provisionMatch.end
    ))
  const synonymMatches = groups.synonyms
    .flatMap((term) => rangesForTerm(term, 'synonym', searchable.text, searchable.references))
    .filter(inProvision)
    .filter((synonym) => ![...provisionMatches, ...queryMatches].some((higherPriority) =>
      higherPriority.index === synonym.index && higherPriority.start < synonym.end && synonym.start < higherPriority.end
    ))
  const matches = [...provisionMatches, ...queryMatches, ...synonymMatches]
    .filter((match, index, all) => all.findIndex((candidate) =>
      candidate.index === match.index && candidate.start === match.start && candidate.end === match.end && candidate.kind === match.kind
    ) === index)
  return { matches, kinds: Array.from(new Set(matches.map((match) => match.kind))) }
}
