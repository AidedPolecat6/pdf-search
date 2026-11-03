import type { IndexedFragment } from './types'

export function searchableFragments(fragments: IndexedFragment[]): IndexedFragment[] {
  const english = new Set<string>()
  const bilingual = new Set<string>()
  const danishPages = new Set<string>()
  const englishPages = new Set<string>()
  for (const fragment of fragments) {
    const text = fragment.text
    const page = `${fragment.documentPath}:${fragment.physicalPage}`
    if (fragment.physicalPage <= 5) {
      if (/DS[-‐]publikationen\s+er\s+på\s+engelsk\s*\./i.test(text)) english.add(fragment.documentPath)
      if (/DS[-‐]publikationen\s+er\s+på\s+dansk\s+og\s+engelsk/i.test(text)) bilingual.add(fragment.documentPath)
    }
    if (/^\s*\d+\s*\(da\)\s+DS\//m.test(text)) danishPages.add(page)
    if (/^\s*[–−-]\s*\d+\s*[–−-]\s*IEC\s+\d/m.test(text)
      || /^\s*English Version\s*$/im.test(text)) englishPages.add(page)
  }
  // shortcut: unmarked publications retain their content; add explicit language metadata when supporting other publishers.
  return fragments.filter(fragment => {
    const page = `${fragment.documentPath}:${fragment.physicalPage}`
    if (english.has(fragment.documentPath)) return false
    if (bilingual.has(fragment.documentPath)) return danishPages.has(page)
    return !englishPages.has(page)
  })
}
