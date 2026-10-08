import { createHash } from 'node:crypto'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { extname, join, normalize, resolve } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, session } from 'electron'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { PdfFile, PdfTextPosition, StoredIndex } from '../shared/types'
import { loadTruthSet } from './truths'

const allowedPdfPaths = new Set<string>()

if (process.env.PORTABLE_EXECUTABLE_DIR) {
  app.setPath('userData', join(process.env.PORTABLE_EXECUTABLE_DIR, 'PDF Search Data'))
}

function indexPath(): string {
  return join(app.getPath('userData'), 'document-index.json')
}

async function describePdf(path: string, known?: PdfFile): Promise<PdfFile> {
  const details = await stat(path)
  if (known && known.size === details.size && known.mtimeMs === details.mtimeMs) {
    return { ...known, path }
  }
  const bytes = await readFile(path)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  return {
    path,
    name: path.split(/[\\/]/).pop() ?? path,
    size: details.size,
    mtimeMs: details.mtimeMs,
    sha256
  }
}

async function scanFolder(folder: string, knownFiles: PdfFile[] = []): Promise<PdfFile[]> {
  const absoluteFolder = resolve(folder)
  const knownByPath = new Map(knownFiles.map((file) => [normalize(file.path), file]))
  const entries = await readdir(absoluteFolder, { withFileTypes: true })
  const paths = entries
    .filter((entry) => entry.isFile() && extname(entry.name).toLocaleLowerCase() === '.pdf')
    .map((entry) => normalize(join(absoluteFolder, entry.name)))
    .sort((left, right) => left.localeCompare(right, 'da'))

  const files = await Promise.all(paths.map((path) => describePdf(path, knownByPath.get(path))))
  allowedPdfPaths.clear()
  files.forEach((file) => allowedPdfPaths.add(normalize(file.path)))
  return files
}

function assertAllowedPdf(path: string): string {
  const normalized = normalize(resolve(path))
  if (!allowedPdfPaths.has(normalized) || extname(normalized).toLocaleLowerCase() !== '.pdf') {
    throw new Error('PDF-filen er ikke godkendt fra den valgte mappe.')
  }
  return normalized
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 640,
    title: 'PDF Search',
    backgroundColor: '#f4f1eb',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  app.setName('PDF Search')

  if (app.isPackaged) {
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      const blocked = /^(https?|wss?):/i.test(details.url)
      callback({ cancel: blocked })
    })
  }

  ipcMain.handle('folder:default', () => null)
  ipcMain.handle('folder:choose', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'], title: 'Vælg mappe med PDF-dokumenter' })
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle('folder:scan', (_event, folder: string, knownFiles?: PdfFile[]) => scanFolder(folder, knownFiles))
  ipcMain.handle('truths:load', (_event, folder: string) => loadTruthSet(
    resolve(folder),
    app.isPackaged ? join(process.resourcesPath, 'data') : resolve('data')
  ))
  ipcMain.handle('pdf:read', async (_event, path: string) => {
    const bytes = await readFile(assertAllowedPdf(path))
    return new Uint8Array(bytes)
  })
  ipcMain.handle('pdf:text-items', async (_event, path: string, pageNumber: number): Promise<PdfTextPosition[]> => {
    const bytes = new Uint8Array(await readFile(assertAllowedPdf(path)))
    const pdf = await getDocument({ data: bytes }).promise
    const page = await pdf.getPage(pageNumber)
    const content = await page.getTextContent()
    const items = content.items.flatMap((item) => 'str' in item ? [{
      str: item.str,
      width: item.width,
      height: item.height,
      transform: Array.from(item.transform)
    }] : [])
    await pdf.cleanup()
    return items
  })
  ipcMain.handle('index:load', async () => {
    try {
      return JSON.parse(await readFile(indexPath(), 'utf8')) as StoredIndex
    } catch {
      return null
    }
  })
  ipcMain.handle('index:save', async (_event, value: StoredIndex) => {
    await writeFile(indexPath(), JSON.stringify(value), 'utf8')
  })

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
