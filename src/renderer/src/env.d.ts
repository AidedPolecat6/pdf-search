import type { OkPdfApi } from '../../preload'

declare global {
  interface Window {
    okPdf: OkPdfApi
  }
}

export {}
