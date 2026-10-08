import { contextBridge, ipcRenderer } from 'electron'
import type { OverviewSet, PdfFile, PdfTextPosition, StoredIndex, TruthSet } from '../shared/types'

const api = {
  getDefaultFolder: (): Promise<string | null> => ipcRenderer.invoke('folder:default'),
  chooseFolder: (): Promise<string | null> => ipcRenderer.invoke('folder:choose'),
  scanFolder: (folder: string, knownFiles: PdfFile[] = []): Promise<PdfFile[]> => ipcRenderer.invoke('folder:scan', folder, knownFiles),
  loadTruths: (folder: string): Promise<TruthSet> => ipcRenderer.invoke('truths:load', folder),
  loadOverview: (folder: string): Promise<OverviewSet> => ipcRenderer.invoke('overview:load', folder),
  readPdf: (path: string): Promise<Uint8Array> => ipcRenderer.invoke('pdf:read', path),
  readPageText: (path: string, page: number): Promise<PdfTextPosition[]> => ipcRenderer.invoke('pdf:text-items', path, page),
  loadIndex: (): Promise<StoredIndex | null> => ipcRenderer.invoke('index:load'),
  saveIndex: (index: StoredIndex): Promise<void> => ipcRenderer.invoke('index:save', index)
}

contextBridge.exposeInMainWorld('okPdf', api)

export type OkPdfApi = typeof api
