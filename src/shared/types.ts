export interface PdfFile {
  path: string
  name: string
  size: number
  mtimeMs: number
  sha256: string
}

export type TextSource = 'native' | 'ocr'

export interface IndexedFragment {
  id: string
  documentPath: string
  documentName: string
  documentHash: string
  physicalPage: number
  provision: string
  text: string
  source: TextSource
  extractionConfidence: number
  parserConfidence: number
}

export interface StoredIndex {
  version: 2
  folder: string
  createdAt: string
  files: PdfFile[]
  fragments: IndexedFragment[]
}

export interface SearchResult {
  id: string
  documentPath: string
  documentName: string
  physicalPage: number
  provision: string
  confidence: number
  source: TextSource
}

export interface IndexProgress {
  documentName: string
  currentDocument: number
  totalDocuments: number
  currentPage: number
  totalPages: number
  message: string
}

export interface PdfTextPosition {
  str: string
  width: number
  height: number
  transform: number[]
  fontName: string
}

export interface TruthRecord {
  id: string
  question: string
  document: string
  provision: string
  physicalPage: number | null
  answer: string
  explanation: string
  keywords: string
}

export interface TruthSet {
  sourcePath: string | null
  records: TruthRecord[]
  warnings: string[]
}

export interface OverviewEntry {
  document: string
  label: string
  title: string
  physicalPage: number | null
}

export interface OverviewSet {
  sourcePath: string | null
  entries: OverviewEntry[]
  warnings: string[]
}

export interface BenchmarkResult {
  total: number
  top1: number
  top3: number
  failures: string[]
}
