import { highlightGroupsForQuery } from './search'

export interface HighlightTextItem {
  str: string
}

export interface HighlightMatch {
  index: number
  start: number
  end: number
  kind: 'query' | 'synonym'
}

export interface HighlightSelection {
  matches: HighlightMatch[]
  kind: 'query' | 'synonym' | 'mixed' | 'none'
}

interface CharacterReference {
  index: number
  offset: number
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

export function locateHighlight(items: HighlightTextItem[], query: string): HighlightSelection {
  const groups = highlightGroupsForQuery(query)
  const searchable = searchableText(items)
  const queryMatches = groups.query.flatMap((term) => rangesForTerm(term, 'query', searchable.text, searchable.references))
  const synonymMatches = groups.synonyms
    .flatMap((term) => rangesForTerm(term, 'synonym', searchable.text, searchable.references))
    .filter((synonym) => !queryMatches.some((queryMatch) =>
      queryMatch.index === synonym.index && queryMatch.start < synonym.end && synonym.start < queryMatch.end
    ))
  const matches = [...queryMatches, ...synonymMatches]
    .filter((match, index, all) => all.findIndex((candidate) =>
      candidate.index === match.index && candidate.start === match.start && candidate.end === match.end && candidate.kind === match.kind
    ) === index)
  const kinds = new Set(matches.map((match) => match.kind))
  return { matches, kind: kinds.size > 1 ? 'mixed' : kinds.has('query') ? 'query' : kinds.has('synonym') ? 'synonym' : 'none' }
}
