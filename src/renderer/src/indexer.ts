import { GlobalWorkerOptions, getDocument, type PDFPageProxy } from 'pdfjs-dist'
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { createWorker, OEM, type Worker } from 'tesseract.js'
import { segmentPage } from '../../shared/provisions'
import type { IndexProgress, IndexedFragment, PdfFile, StoredIndex, TextSource } from '../../shared/types'

GlobalWorkerOptions.workerSrc = pdfWorker

function assetUrl(relativePath: string): string {
  return new URL(relativePath, window.location.href).href.replace(/\/$/, '')
}

async function nativePageText(page: PDFPageProxy): Promise<string> {
  const content = await page.getTextContent()
  let text = ''
  for (const item of content.items) {
    if (!('str' in item)) continue
    text += item.str
    text += item.hasEOL ? '\n' : ' '
  }
  return text.trim()
}

async function renderForOcr(page: PDFPageProxy): Promise<HTMLCanvasElement> {
  const viewport = page.getViewport({ scale: 2 })
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(viewport.width)
  canvas.height = Math.ceil(viewport.height)
  const context = canvas.getContext('2d', { alpha: false })
  if (!context) throw new Error('Kunne ikke oprette lærred til OCR.')
  await page.render({ canvasContext: context, viewport, canvas }).promise
  return canvas
}

async function makeOcrWorker(onMessage: (message: string) => void): Promise<Worker> {
  return createWorker(['dan', 'eng'], OEM.LSTM_ONLY, {
    workerPath: assetUrl('ocr/worker.min.js'),
    corePath: assetUrl('ocr/core'),
    langPath: assetUrl('ocr/lang'),
    gzip: true,
    workerBlobURL: false,
    logger: (event) => {
      if (event.status) onMessage(`OCR: ${event.status}`)
    }
  })
}

function unchanged(previous: StoredIndex | null, file: PdfFile): boolean {
  return previous?.version === 2 && (previous.files.some((candidate) => candidate.path === file.path && candidate.sha256 === file.sha256) ?? false)
}

export async function buildIndex(
  folder: string,
  files: PdfFile[],
  previous: StoredIndex | null,
  onProgress: (progress: IndexProgress) => void
): Promise<StoredIndex> {
  const fragments: IndexedFragment[] = []
  let ocrWorker: Worker | null = null

  try {
    for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
      const file = files[fileIndex]
      if (unchanged(previous, file)) {
        fragments.push(...previous!.fragments.filter((fragment) => fragment.documentPath === file.path))
        onProgress({
          documentName: file.name,
          currentDocument: fileIndex + 1,
          totalDocuments: files.length,
          currentPage: 0,
          totalPages: 0,
          message: 'Uændret dokument genbrugt'
        })
        continue
      }

      const bytes = await window.okPdf.readPdf(file.path)
      const pdf = await getDocument({ data: bytes }).promise
      let context = undefined

      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        onProgress({
          documentName: file.name,
          currentDocument: fileIndex + 1,
          totalDocuments: files.length,
          currentPage: pageNumber,
          totalPages: pdf.numPages,
          message: 'Udtrækker tekst'
        })
        const page = await pdf.getPage(pageNumber)
        let text = await nativePageText(page)
        let source: TextSource = 'native'
        let extractionConfidence = 1

        if (text.replace(/\s/g, '').length < 24) {
          ocrWorker ??= await makeOcrWorker((message) => onProgress({
            documentName: file.name,
            currentDocument: fileIndex + 1,
            totalDocuments: files.length,
            currentPage: pageNumber,
            totalPages: pdf.numPages,
            message
          }))
          const result = await ocrWorker.recognize(await renderForOcr(page))
          text = result.data.text
          source = 'ocr'
          extractionConfidence = Math.max(0, Math.min(1, result.data.confidence / 100))
        }

        const segmented = segmentPage({
          documentPath: file.path,
          documentName: file.name,
          documentHash: file.sha256,
          physicalPage: pageNumber,
          text,
          source,
          extractionConfidence,
          previousContext: context
        })
        context = segmented.context
        fragments.push(...segmented.fragments)
        page.cleanup()
      }
      await pdf.cleanup()
    }
  } finally {
    await ocrWorker?.terminate()
  }

  return {
    version: 2,
    folder,
    createdAt: new Date().toISOString(),
    files,
    fragments
  }
}
