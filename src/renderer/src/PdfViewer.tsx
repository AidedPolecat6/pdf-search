import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { GlobalWorkerOptions, getDocument, Util, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist'
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { containsVisibleInk, locateHighlight } from '../../shared/highlights'
import type { PdfTextPosition, TextSource } from '../../shared/types'
import { layoutPages, pageAtOffset, visiblePageRange, type PageSize } from './pdfLayout'

GlobalWorkerOptions.workerSrc = pdfWorker

interface PdfViewerProps {
  path: string
  title: string
  initialPage: number
  provision: string
  query: string
  source: TextSource
  onClose: () => void
}

interface HighlightBox {
  left: number
  top: number
  width: number
  height: number
  kind: 'query' | 'synonym' | 'provision'
}

interface HighlightResult {
  boxes: HighlightBox[]
  items: number
  selected: number
  anchor: boolean
  provision: boolean
  hiddenFonts: string
}

function mergeLineBoxes(boxes: HighlightBox[]): HighlightBox[] {
  const sorted = [...boxes].sort((left, right) => left.top - right.top || left.left - right.left)
  const merged: HighlightBox[] = []
  for (const box of sorted) {
    const current = merged.at(-1)
    const sameLine = current && Math.abs(current.top - box.top) <= Math.max(3, Math.min(current.height, box.height) * 0.4)
    const touches = current && box.left <= current.left + current.width + 10
    if (current && current.kind === box.kind && sameLine && touches) {
      const right = Math.max(current.left + current.width, box.left + box.width)
      const bottom = Math.max(current.top + current.height, box.top + box.height)
      current.left = Math.min(current.left, box.left)
      current.top = Math.min(current.top, box.top)
      current.width = right - current.left
      current.height = bottom - current.top
    } else {
      merged.push({ ...box })
    }
  }
  return merged
}

function boxContainsVisibleInk(context: CanvasRenderingContext2D, canvas: HTMLCanvasElement, box: HighlightBox): boolean {
  const scaleX = canvas.width / Math.max(1, canvas.getBoundingClientRect().width)
  const scaleY = canvas.height / Math.max(1, canvas.getBoundingClientRect().height)
  const left = Math.max(0, Math.floor(box.left * scaleX))
  const top = Math.max(0, Math.floor(box.top * scaleY))
  const width = Math.min(canvas.width - left, Math.max(1, Math.ceil(box.width * scaleX)))
  const height = Math.min(canvas.height - top, Math.max(1, Math.ceil(box.height * scaleY)))
  if (width <= 0 || height <= 0) return false
  const pixels = context.getImageData(left, top, width, height)
  return containsVisibleInk(pixels.data, pixels.width, pixels.height)
}

function highlightStatus(kinds: HighlightBox['kind'][], source: TextSource): string {
  const labels = [
    kinds.includes('provision') ? 'Henvisning' : '',
    kinds.includes('query') ? 'søgeord' : '',
    kinds.includes('synonym') ? 'synonymer' : ''
  ].filter(Boolean)
  if (!labels.length) return source === 'ocr' ? 'OCR-side uden præcis markering' : 'Markering ikke fundet'
  if (labels.length === 1) return `${labels[0]} markeret`
  return `${labels.slice(0, -1).join(', ')} og ${labels.at(-1)} markeret`
}

function PdfPage({ pdf, page, zoom, query, provision, showHighlights, readText, onSize, onHighlights }: {
  pdf: PDFDocumentProxy
  page: number
  zoom: number
  query: string
  provision: string
  showHighlights: boolean
  readText?: () => Promise<PdfTextPosition[]>
  onSize: (page: number, size: PageSize) => void
  onHighlights: (result: HighlightResult) => void
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [highlights, setHighlights] = useState<HighlightBox[]>([])

  useEffect(() => {
    if (!pdf || !canvasRef.current) return
    let cancelled = false
    let renderTask: RenderTask | undefined
    const canvas = canvasRef.current
    void pdf.getPage(page).then(async (pdfPage) => {
      if (cancelled) return
      try {
      const natural = pdfPage.getViewport({ scale: 1 })
      onSize(page, { width: natural.width, height: natural.height })
      const cssViewport = pdfPage.getViewport({ scale: zoom })
      const renderViewport = pdfPage.getViewport({ scale: zoom * window.devicePixelRatio })
      const textItems = readText ? await readText() : null
      if (cancelled) return
      const context = canvas.getContext('2d', { alpha: false })
      if (!context) return
      canvas.width = Math.ceil(renderViewport.width)
      canvas.height = Math.ceil(renderViewport.height)
      canvas.style.width = `${Math.ceil(cssViewport.width)}px`
      canvas.style.height = `${Math.ceil(cssViewport.height)}px`
      renderTask = pdfPage.render({ canvasContext: context, viewport: renderViewport, canvas })
      await renderTask.promise
      if (cancelled) return

      if (textItems) {
        const selection = locateHighlight(textItems, query, provision)
        const boxFor = (match: { index: number; start: number; end: number; kind: HighlightBox['kind'] }): HighlightBox => {
          const item = textItems[match.index]
          const transform = Util.transform(cssViewport.transform, item.transform)
          const height = Math.max(8, Math.hypot(transform[2], transform[3]), item.height * zoom)
          const itemWidth = item.width * cssViewport.scale
          return {
            left: transform[4] + itemWidth * match.start / Math.max(1, item.str.length) - 2,
            top: transform[5] - height - 1,
            width: Math.max(4, itemWidth * (match.end - match.start) / Math.max(1, item.str.length) + 4),
            height: height + 3,
            kind: match.kind
          }
        }
        const fontVisibility = new Map<string, { visible: number; total: number }>()
        textItems.forEach((item, index) => {
          if (!item.str.trim()) return
          const stats = fontVisibility.get(item.fontName) ?? { visible: 0, total: 0 }
          stats.total += 1
          if (boxContainsVisibleInk(context, canvas, boxFor({ index, start: 0, end: item.str.length, kind: 'query' }))) stats.visible += 1
          fontVisibility.set(item.fontName, stats)
        })
        // PDF.js exposes clipped translation layers as ordinary text; reject fonts whose geometry is not consistently visible.
        const hiddenFonts = new Set(Array.from(fontVisibility)
          .filter(([, stats]) => stats.total >= 8 && stats.total - stats.visible >= 2 && stats.visible / stats.total < 0.9)
          .map(([fontName]) => fontName))
        const boxes = selection.matches
          .filter((match) => !hiddenFonts.has(textItems[match.index].fontName))
          .map(boxFor)
          .filter((box) => boxContainsVisibleInk(context, canvas, box))
        if (!cancelled) {
          setHighlights(mergeLineBoxes(boxes))
          onHighlights({
            boxes: mergeLineBoxes(boxes),
            items: textItems.length,
            selected: boxes.length,
            anchor: boxes.some((box) => box.kind === 'query'),
            provision: boxes.some((box) => box.kind === 'provision'),
            hiddenFonts: Array.from(hiddenFonts).join(',')
          })
        }
      } else if (!cancelled) {
        setHighlights([])
      }
      } finally {
        pdfPage.cleanup()
      }
    }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : 'Siden kunne ikke vises.')
    })
    return () => {
      cancelled = true
      renderTask?.cancel()
    }
  }, [pdf, page, zoom, query, provision, readText, onSize, onHighlights])

  return <>
    {error && <div className="error-card">Side {page}: {error}</div>}
    <canvas ref={canvasRef} aria-label={`PDF-side ${page}`} />
    {showHighlights && <div className="pdf-highlight-layer" aria-label={`Markering af ${provision}`}>
      {highlights.map((box, index) => <span
        className={`pdf-highlight-box pdf-highlight-${box.kind}`}
        data-highlight-index={index}
        key={`${box.left}-${box.top}-${index}`}
        style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
      />)}
    </div>}
  </>
}

export function PdfViewer({ path, title, initialPage, provision, query, source, onClose }: PdfViewerProps): React.JSX.Element {
  const stageRef = useRef<HTMLDivElement>(null)
  const [document, setDocument] = useState<{ pdf: PDFDocumentProxy; size: PageSize } | null>(null)
  const pdf = document?.pdf
  const [page, setPage] = useState(initialPage)
  const [zoom, setZoom] = useState(1.2)
  const [error, setError] = useState<string | null>(null)
  const [sizes, setSizes] = useState<Map<number, PageSize>>(() => new Map())
  const measuredSizes = useRef(new Map<number, PageSize>())
  const [range, setRange] = useState<[number, number]>([0, 0])
  const [showHighlights, setShowHighlights] = useState(true)
  const [highlightDiagnostics, setHighlightDiagnostics] = useState<HighlightResult>({ boxes: [], items: 0, selected: 0, anchor: false, provision: false, hiddenFonts: '' })
  const highlights = highlightDiagnostics.boxes
  const highlightKinds = Array.from(new Set(highlights.map(box => box.kind)))
  const pages = useMemo(() => document ? layoutPages(document.pdf.numPages, document.size, sizes, zoom) : [], [document, sizes, zoom])
  const pagesRef = useRef(pages)
  const pendingPosition = useRef<{ index: number; fraction: number } | null>({ index: Math.max(0, initialPage - 1), fraction: 0 })
  const initialHighlightPending = useRef(true)
  const textPromise = useRef<Promise<PdfTextPosition[]> | null>(null)
  const readText = useCallback(() => textPromise.current ??= window.okPdf.readPageText(path, initialPage), [path, initialPage])
  const onHighlights = useCallback((result: HighlightResult) => setHighlightDiagnostics(result), [])

  useEffect(() => {
    let active = true
    let loading: ReturnType<typeof getDocument> | undefined
    void (async () => {
      const bytes = await window.okPdf.readPdf(path)
      if (!active) return
      loading = getDocument({ data: bytes })
      const pdf = await loading.promise
      const first = await pdf.getPage(Math.max(1, Math.min(pdf.numPages, initialPage)))
      const viewport = first.getViewport({ scale: 1 })
      if (active) setDocument({ pdf, size: { width: viewport.width, height: viewport.height } })
    })().catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : 'PDF-filen kunne ikke åbnes.')
    })
    return () => { active = false; void loading?.destroy() }
  }, [path, initialPage])

  const updateViewport = useCallback(() => {
    const stage = stageRef.current
    const layout = pagesRef.current
    if (!stage || !layout.length) return
    const top = Math.max(0, stage.scrollTop - 34)
    setPage(pageAtOffset(layout, top + Math.min(200, stage.clientHeight / 3)) + 1)
    const next = visiblePageRange(layout, top, stage.clientHeight)
    setRange(old => old[0] === next[0] && old[1] === next[1] ? old : next)
  }, [])

  const rememberPosition = useCallback(() => {
    const stage = stageRef.current
    const layout = pagesRef.current
    if (!stage || !layout.length || pendingPosition.current) return
    const top = Math.max(0, stage.scrollTop - 34)
    const index = pageAtOffset(layout, top)
    pendingPosition.current = { index, fraction: (top - layout[index].top) / layout[index].height }
  }, [])

  const onSize = useCallback((number: number, size: PageSize) => {
    const existing = measuredSizes.current.get(number)
    if (existing?.width === size.width && existing.height === size.height) return
    rememberPosition()
    measuredSizes.current = new Map(measuredSizes.current).set(number, size)
    setSizes(measuredSizes.current)
  }, [rememberPosition])

  useLayoutEffect(() => {
    pagesRef.current = pages
    const stage = stageRef.current
    if (!stage || !pages.length) return
    const position = pendingPosition.current
    if (position) {
      const target = pages[Math.min(position.index, pages.length - 1)]
      stage.scrollTop = 34 + target.top + target.height * position.fraction
      pendingPosition.current = null
    }
    if (initialHighlightPending.current && highlights.length) {
      const first = highlights.find(box => box.kind === 'provision') ?? highlights[0]
      stage.scrollTop = Math.max(0, 34 + pages[Math.max(0, Math.min(initialPage - 1, pages.length - 1))].top + first.top - stage.clientHeight * 0.3)
      initialHighlightPending.current = false
    }
    updateViewport()
  }, [pages, highlights, initialPage, updateViewport])

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const observer = new ResizeObserver(updateViewport)
    observer.observe(stage)
    return () => observer.disconnect()
  }, [updateViewport])

  const navigate = (number: number): void => {
    const target = pages[number - 1]
    if (!target || !stageRef.current) return
    initialHighlightPending.current = false
    pendingPosition.current = null
    stageRef.current.scrollTop = 34 + target.top
    updateViewport()
  }

  const changeZoom = (change: number): void => {
    const next = Math.min(2.4, Math.max(0.6, zoom + change))
    if (next === zoom) return
    rememberPosition()
    setZoom(next)
  }

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      const target = event.target
      if (event.defaultPrevented || event.isComposing || (target instanceof HTMLElement
        && (target.isContentEditable || target.closest('input, textarea, select')))) return
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      } else if (!event.ctrlKey && !event.altKey && !event.metaKey && event.key.toLocaleLowerCase('da-DK') === 'm' && highlights.length) {
        event.preventDefault()
        setShowHighlights((value) => !value)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [highlights.length, onClose])

  return (
    <aside className="viewer-shell" aria-label={`Viser ${title}`}>
      <header className="viewer-toolbar">
        <button className="icon-button" onClick={onClose} aria-label="Luk dokument" autoFocus>×</button>
        <div className="viewer-title">
          <strong>{title}</strong>
          <span>Fysisk PDF-side {page}{pdf ? ` af ${pdf.numPages}` : ''} · {provision}</span>
        </div>
        {page === initialPage && (
          <div
            className={`highlight-status ${highlightKinds.length ? 'highlight-status-terms' : 'highlight-status-none'}`}
            data-text-items={highlightDiagnostics.items}
            data-selected-items={highlightDiagnostics.selected}
            data-anchor-found={highlightDiagnostics.anchor}
            data-provision-found={highlightDiagnostics.provision}
            data-hidden-fonts={highlightDiagnostics.hiddenFonts}
          >
            {highlightStatus(highlightKinds, source)}
          </div>
        )}
        <div className="viewer-controls">
          <div className="viewer-highlight-controls">
          {Boolean(highlights.length) && (
            <>
              <div className="highlight-legend" aria-label="Markeringsfarver">
                <span><i className="highlight-legend-provision" />Henvisning</span>
                <span><i className="highlight-legend-query" />Dine søgeord</span>
                <span><i className="highlight-legend-synonym" />Synonymer</span>
              </div>
              <button
                className={`highlight-toggle ${showHighlights ? 'highlight-toggle-active' : ''}`}
                onClick={() => setShowHighlights((value) => !value)}
                aria-pressed={showHighlights}
                title="Tast M for at skifte markeringen"
              >
                {showHighlights ? 'Skjul markering' : 'Vis markering'}
                <kbd>M</kbd>
              </button>
            </>
          )}
          </div>
          <div className="viewer-control-group viewer-page-controls">
            <button disabled={!pdf || page <= 1} onClick={() => navigate(page - 1)}>Forrige</button>
            <button disabled={!pdf || page >= pdf.numPages} onClick={() => navigate(page + 1)}>Næste</button>
          </div>
          <div className="viewer-control-group viewer-zoom-controls">
            <button onClick={() => changeZoom(-0.15)}>−</button>
            <span>{Math.round(zoom * 100)} %</span>
            <button onClick={() => changeZoom(0.15)}>+</button>
          </div>
        </div>
      </header>
      <div className="viewer-stage" ref={stageRef} onScroll={updateViewport}
        onWheel={() => { initialHighlightPending.current = false }}
        onPointerDown={() => { initialHighlightPending.current = false }}
        onKeyDown={event => {
          if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) initialHighlightPending.current = false
        }}
        tabIndex={0} aria-label="PDF-sider – rul op eller ned">
        {error ? <div className="error-card">{error}</div> : !pdf ? <p role="status">Åbner PDF…</p> : (
          <div className="pdf-pages" style={{ height: (pages.at(-1)?.top ?? 0) + (pages.at(-1)?.height ?? 0), width: Math.max(...pages.map(item => item.width)) }}>
            {pages.slice(range[0], range[1]).map((item, index) => {
              const number = range[0] + index + 1
              return <div key={number} className="pdf-page-surface" data-page-number={number}
                style={{ top: item.top, width: item.width, height: item.height }}>
                <PdfPage key={`${number}:${zoom}`} pdf={pdf} page={number} zoom={zoom} query={query} provision={provision}
                  readText={number === initialPage ? readText : undefined} showHighlights={showHighlights}
                  onSize={onSize} onHighlights={onHighlights} />
              </div>
            })}
          </div>
        )}
      </div>
    </aside>
  )
}
