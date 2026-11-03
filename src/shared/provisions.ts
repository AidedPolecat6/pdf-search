import type { IndexedFragment, TextSource } from './types'
import { normalizeText } from './normalize'

interface ProvisionContext {
  section?: string
  subsection?: string
  standardClause?: string
}

interface SegmentContext extends ProvisionContext {
  languageContexts?: Partial<Record<'da' | 'en', ProvisionContext>>
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

function lawFragments(section: string, body: string, initialSubsection = '1'): Array<{ provision: string; text: string; confidence: number }> {
  const subsectionMatches = Array.from(body.matchAll(/^\s*Stk\.\s*(\d+)\.?\s*/gimu))
  const subsectionParts = subsectionMatches.length
    ? [
        { number: initialSubsection, body: body.slice(0, subsectionMatches[0].index) },
        ...subsectionMatches.map((match, index) => ({
          number: match[1],
          body: body.slice(match.index, subsectionMatches[index + 1]?.index ?? body.length)
        }))
      ]
    : [{ number: initialSubsection, body }]

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

function segmentPageContent(input: SegmentInput): SegmentedPage {
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

  const preserveContinuation = (prefix: string): void => {
    if (!prefix.trim()) return
    if (context.section) {
      for (const fragment of lawFragments(context.section, prefix, context.subsection)) {
        push(fragment.provision, fragment.text, fragment.confidence, fragments.length)
      }
      const subsections = Array.from(prefix.matchAll(/^\s*Stk\.\s*(\d+)\.?\s*/gimu))
      context.subsection = subsections.at(-1)?.[1] ?? context.subsection
    } else {
      push(context.standardClause ? `${context.standardClause} (fortsat)` : 'Side uden identificeret bestemmelse',
        prefix, context.standardClause ? 0.7 : 0.25, fragments.length)
    }
  }

  if (lawSections.length) {
    preserveContinuation(text.slice(0, lawSections[0].marker.index))
    let index = fragments.length
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
    preserveContinuation(text.slice(0, standardSections[0].marker.index))
    standardSections.forEach((part) => {
      context = { standardClause: part.marker[1] }
      push(part.marker[1], part.body, 0.9, fragments.length)
    })
    return { fragments, context }
  }

  if (context.section && /^\s*Stk\.\s*\d+/imu.test(text)) {
    preserveContinuation(text)
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

export function segmentPage(input: SegmentInput): SegmentedPage {
  const header = input.text.trimStart().split('\n')[0]
  const language = /^\d+\s*\(da\)\s+DS\//.test(header) ? 'da'
    : /^[–−-]\s*\d+\s*[–−-]\s*IEC\s+\d/.test(header) ? 'en' : null
  const previous = input.previousContext
  const result = segmentPageContent({ ...input,
    previousContext: language ? previous?.languageContexts?.[language] : previous })
  if (language || previous?.languageContexts) {
    const languageContexts = { ...previous?.languageContexts }
    if (language) languageContexts[language] = {
      section: result.context.section, subsection: result.context.subsection,
      standardClause: result.context.standardClause
    }
    result.context = { ...result.context, languageContexts }
  }
  return result
}
