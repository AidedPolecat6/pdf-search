import { useEffect, useRef, useState } from 'react'
import { GlobalWorkerOptions, getDocument, Util, type PDFDocumentProxy } from 'pdfjs-dist'
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { containsVisibleInk, locateHighlight } from '../../shared/highlights'
import type { TextSource } from '../../shared/types'

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

interface PdfTextItem {
  str: string
  width: number
  height: number
  transform: number[]
  fontName: string
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

export function PdfViewer({ path, title, initialPage, provision, query, source, onClose }: PdfViewerProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [page, setPage] = useState(initialPage)
  const [zoom, setZoom] = useState(1.2)
  const [error, setError] = useState<string | null>(null)
  const [pageSize, setPageSize] = useState({ width: 0, height: 0 })
  const [highlights, setHighlights] = useState<HighlightBox[]>([])
  const [highlightKinds, setHighlightKinds] = useState<HighlightBox['kind'][]>([])
  const [showHighlights, setShowHighlights] = useState(true)
  const [highlightDiagnostics, setHighlightDiagnostics] = useState({ items: 0, selected: 0, anchor: false, provision: false, hiddenFonts: '' })

  useEffect(() => {
    let active = true
    void window.okPdf.readPdf(path)
      .then((bytes) => getDocument({ data: bytes }).promise)
      .then((document) => active ? setPdf(document) : document.cleanup())
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'PDF-filen kunne ikke åbnes.'))
    return () => {
      active = false
    }
  }, [path])

  useEffect(() => {
    if (!pdf || !canvasRef.current) return
    let cancelled = false
    void pdf.getPage(page).then(async (pdfPage) => {
      if (cancelled || !canvasRef.current) return
      const cssViewport = pdfPage.getViewport({ scale: zoom })
      const renderViewport = pdfPage.getViewport({ scale: zoom * window.devicePixelRatio })
      const textItems = page === initialPage ? await window.okPdf.readPageText(path, page) : null
      const canvas = canvasRef.current
      const context = canvas.getContext('2d', { alpha: false })
      if (!context) return
      canvas.width = Math.ceil(renderViewport.width)
      canvas.height = Math.ceil(renderViewport.height)
      canvas.style.width = `${Math.ceil(cssViewport.width)}px`
      canvas.style.height = `${Math.ceil(cssViewport.height)}px`
      setPageSize({ width: Math.ceil(cssViewport.width), height: Math.ceil(cssViewport.height) })
      await pdfPage.render({ canvasContext: context, viewport: renderViewport, canvas }).promise

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
          setHighlightKinds(Array.from(new Set(boxes.map((box) => box.kind))))
          setHighlightDiagnostics({
            items: textItems.length,
            selected: boxes.length,
            anchor: boxes.some((box) => box.kind === 'query'),
            provision: boxes.some((box) => box.kind === 'provision'),
            hiddenFonts: Array.from(hiddenFonts).join(',')
          })
        }
      } else if (!cancelled) {
        setHighlights([])
        setHighlightKinds([])
      }
      pdfPage.cleanup()
    }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Siden kunne ikke vises.'))
    return () => {
      cancelled = true
    }
  }, [pdf, page, zoom])

  useEffect(() => {
    if (!showHighlights || !highlights.length || !stageRef.current || !surfaceRef.current) return
    const stage = stageRef.current
    const surface = surfaceRef.current
    const first = highlights.find((highlight) => highlight.kind === 'provision') ?? highlights[0]
    requestAnimationFrame(() => {
      stage.scrollTo({
        top: Math.max(0, surface.offsetTop + first.top - stage.clientHeight * 0.3),
        left: Math.max(0, surface.offsetLeft + first.left - stage.clientWidth * 0.3),
        behavior: 'smooth'
      })
    })
  }, [highlights, showHighlights])

  useEffect(() => () => {
    void pdf?.cleanup()
  }, [pdf])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
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
          <div className="viewer-control-group viewer-page-controls">
            <button disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>Forrige</button>
            <button disabled={!pdf || page >= pdf.numPages} onClick={() => setPage((value) => value + 1)}>Næste</button>
          </div>
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
          <div className="viewer-control-group viewer-zoom-controls">
            <button onClick={() => setZoom((value) => Math.max(0.6, value - 0.15))}>−</button>
            <span>{Math.round(zoom * 100)} %</span>
            <button onClick={() => setZoom((value) => Math.min(2.4, value + 0.15))}>+</button>
          </div>
        </div>
      </header>
      <div className="viewer-stage" ref={stageRef}>
        {error ? <div className="error-card">{error}</div> : (
          <div className="pdf-page-surface" ref={surfaceRef} style={{ width: pageSize.width, height: pageSize.height }}>
            <canvas ref={canvasRef} />
            {showHighlights && (
              <div className="pdf-highlight-layer" aria-label={`Markering af ${provision}`}>
                {highlights.map((box, index) => (
                  <span
                    className={`pdf-highlight-box pdf-highlight-${box.kind}`}
                    data-highlight-index={index}
                    key={`${box.left}-${box.top}-${index}`}
                    style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  )
}
