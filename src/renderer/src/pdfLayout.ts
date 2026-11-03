export interface PageSize { width: number; height: number }
export interface PageLayout extends PageSize { top: number }
export const PAGE_GAP = 24

export function layoutPages(count: number, fallback: PageSize, measured: ReadonlyMap<number, PageSize>, zoom: number): PageLayout[] {
  let top = 0
  return Array.from({ length: count }, (_, index) => {
    const size = measured.get(index + 1) ?? fallback
    const page = { top, width: Math.ceil(size.width * zoom), height: Math.ceil(size.height * zoom) }
    top += page.height + PAGE_GAP
    return page
  })
}

export function pageAtOffset(pages: readonly PageLayout[], offset: number): number {
  let low = 0
  let high = pages.length - 1
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (pages[middle].top <= offset) low = middle
    else high = middle - 1
  }
  return low
}

export function visiblePageRange(pages: readonly PageLayout[], top: number, height: number): [number, number] {
  if (!pages.length) return [0, 0]
  return [Math.max(0, pageAtOffset(pages, top) - 1), Math.min(pages.length, pageAtOffset(pages, top + height) + 2)]
}
