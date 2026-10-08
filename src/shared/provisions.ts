import type { IndexedFragment, TextSource } from './types'
import { normalizeText } from './normalize'

interface SegmentContext {
  section?: string
  subsection?: string
  standardClause?: string
}

interface SegmentInput {
  documentPath: string
  documentName: string
  documentHash: string
  physicalPage: number
  text: string
  source: TextSource
  extractionConfidence: number
  previousContext?: SegmentContext
}

export interface SegmentedPage {
  fragments: IndexedFragment[]
  context: SegmentContext
}

const LAW_SECTION = /^\s*§\s*(\d+[a-z]?)\.?\s*/gimu
const STANDARD_CLAUSE = /^\s*(\d+(?:\.(?:\d+|[A-Z]\d*))+|[A-Z]\.\d+(?:\.\d+)*)\s+([^\n]{3,})/gmu

function splitAtMatches(text: string, regex: RegExp): Array<{ marker: RegExpExecArray; body: string }> {
  const matches = Array.from(text.matchAll(regex))
  return matches.map((marker, index) => ({
    marker,
    body: text.slice(marker.index, matches[index + 1]?.index ?? text.length)
  }))
}

function lawFragments(section: string, body: string): Array<{ provision: string; text: string; confidence: number }> {
  const subsectionMatches = Array.from(body.matchAll(/^\s*Stk\.\s*(\d+)\.?\s*/gimu))
  const subsectionParts = subsectionMatches.length
    ? [
        { number: '1', body: body.slice(0, subsectionMatches[0].index) },
        ...subsectionMatches.map((match, index) => ({
          number: match[1],
          body: body.slice(match.index, subsectionMatches[index + 1]?.index ?? body.length)
        }))
      ]
    : [{ number: '1', body }]

  const output: Array<{ provision: string; text: string; confidence: number }> = []
  for (const subsection of subsectionParts) {
    if (!subsection.body.trim()) continue
    const itemMatches = Array.from(subsection.body.matchAll(/^\s*(\d+)\)\s*/gmu))
    if (!itemMatches.length) {
      output.push({
        provision: `§ ${section}, stk. ${subsection.number}`,
        text: subsection.body,
        confidence: 0.98
      })
      continue
    }

    const intro = subsection.body.slice(0, itemMatches[0].index).trim()
    for (let index = 0; index < itemMatches.length; index += 1) {
      const item = itemMatches[index]
      const itemText = subsection.body.slice(item.index, itemMatches[index + 1]?.index ?? subsection.body.length)
      output.push({
        provision: `§ ${section}, stk. ${subsection.number}, nr. ${item[1]}`,
        text: `${intro}\n${itemText}`,
        confidence: 0.99
      })
    }
  }
  return output
}

export function segmentPage(input: SegmentInput): SegmentedPage {
  const text = normalizeText(input.text)
  const lawSections = splitAtMatches(text, LAW_SECTION)
  const fragments: IndexedFragment[] = []
  let context: SegmentContext = { ...input.previousContext }

  const push = (provision: string, fragmentText: string, parserConfidence: number, index: number): void => {
    const clean = normalizeText(fragmentText)
    if (!clean) return
    fragments.push({
      id: `${input.documentHash}:${input.physicalPage}:${index}`,
      documentPath: input.documentPath,
      documentName: input.documentName,
      documentHash: input.documentHash,
      physicalPage: input.physicalPage,
      provision,
      text: clean,
      source: input.source,
      extractionConfidence: input.extractionConfidence,
      parserConfidence
    })
  }

  if (lawSections.length) {
    let index = 0
    for (const part of lawSections) {
      const section = part.marker[1]
      const subsections = Array.from(part.body.matchAll(/^\s*Stk\.\s*(\d+)\.?\s*/gimu))
      context = { section, subsection: subsections.at(-1)?.[1] ?? '1' }
      for (const fragment of lawFragments(section, part.body)) {
        push(fragment.provision, fragment.text, fragment.confidence, index++)
      }
    }
    return { fragments, context }
  }

  const standardSections = splitAtMatches(text, STANDARD_CLAUSE)
  if (standardSections.length) {
    standardSections.forEach((part, index) => {
      context = { standardClause: part.marker[1] }
      push(part.marker[1], part.body, 0.9, index)
    })
    return { fragments, context }
  }

  const inherited = context.section
    ? `§ ${context.section}, stk. ${context.subsection ?? '1'} (fortsat)`
    : context.standardClause
      ? `${context.standardClause} (fortsat)`
      : 'Side uden identificeret bestemmelse'
  push(inherited, text, context.section || context.standardClause ? 0.7 : 0.25, 0)
  return { fragments, context }
}
