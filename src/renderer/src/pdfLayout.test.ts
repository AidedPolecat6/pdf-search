import { describe, expect, it } from 'vitest'
import { layoutPages, pageAtOffset, visiblePageRange } from './pdfLayout'

describe('continuous PDF layout', () => {
  it('renders only nearby pages in a 965-page document, including at each end', () => {
    const pages = layoutPages(965, { width: 595, height: 842 }, new Map(), 1.2)
    expect(visiblePageRange(pages, 0, 900)).toEqual([0, 2])
    expect(visiblePageRange(pages, pages[172].top, 900)).toEqual([171, 174])
    expect(visiblePageRange(pages, pages[964].top, 900)).toEqual([963, 965])
    expect(pageAtOffset(pages, -100)).toBe(0)
    expect(pageAtOffset(pages, Number.MAX_SAFE_INTEGER)).toBe(964)
  })

  it('accounts for measured landscape pages and zoom without losing the page anchor', () => {
    const measured = new Map([[2, { width: 842, height: 595 }]])
    const pages = layoutPages(3, { width: 595, height: 842 }, measured, 1)
    expect(pages[2].top).toBe(842 + 24 + 595 + 24)
    const zoomed = layoutPages(3, { width: 595, height: 842 }, measured, 2)
    const anchor = pages[1].top + pages[1].height * 0.4
    const index = pageAtOffset(pages, anchor)
    const fraction = (anchor - pages[index].top) / pages[index].height
    expect(index).toBe(1)
    expect(zoomed[index].top + fraction * zoomed[index].height).toBeCloseTo(1708 + 476)
    expect(visiblePageRange([], 0, 1000)).toEqual([0, 0])
  })
})
