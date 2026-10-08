import { useEffect, useRef, useState, useTransition } from 'react'
import { buildIndex } from './indexer'
import { PdfViewer } from './PdfViewer'
import { DocumentSearch } from '../../shared/search'
import { parseQuery } from '../../shared/normalize'
import type { BenchmarkResult, IndexProgress, PdfFile, SearchResult, StoredIndex, TextSource, TruthSet } from '../../shared/types'

interface ViewerState {
  path: string
  title: string
  page: number
  provision: string
  query: string
  source: TextSource
}

const DISABLED_DOCUMENTS_KEY = 'ok-pdf-disabled-documents'
const FAVORITE_DOCUMENTS_KEY = 'ok-pdf-favorite-documents'

interface Activity {
  message: string
  current?: number
  total?: number
}

interface DocumentMenu {
  path: string
  x: number
  y: number
}

function storedPaths(key: string): Set<string> {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? '[]')
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [])
  } catch {
    return new Set()
  }
}

function indexIsCurrent(index: StoredIndex | null, folder: string, files: PdfFile[]): boolean {
  return Boolean(index && index.version === 2 && index.folder === folder && index.files.length === files.length &&
    files.every((file) => index.files.some((indexed) => indexed.path === file.path && indexed.sha256 === file.sha256)))
}

const yieldToUi = (): Promise<void> => new Promise((resolveYield) => setTimeout(resolveYield, 0))

export default function App(): React.JSX.Element {
  const [folder, setFolder] = useState('')
  const [files, setFiles] = useState<PdfFile[]>([])
  const [index, setIndex] = useState<StoredIndex | null>(null)
  const [search, setSearch] = useState<DocumentSearch | null>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [progress, setProgress] = useState<IndexProgress | null>(null)
  const [isIndexing, setIsIndexing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [viewer, setViewer] = useState<ViewerState | null>(null)
  const [truths, setTruths] = useState<TruthSet>({ sourcePath: null, records: [], warnings: [] })
  const [benchmark, setBenchmark] = useState<BenchmarkResult>({ total: 0, top1: 0, top3: 0, failures: [] })
  const [disabledDocuments, setDisabledDocuments] = useState<Set<string>>(() => storedPaths(DISABLED_DOCUMENTS_KEY))
  const [favoriteDocuments, setFavoriteDocuments] = useState<Set<string>>(() => storedPaths(FAVORITE_DOCUMENTS_KEY))
  const [documentMenu, setDocumentMenu] = useState<DocumentMenu | null>(null)
  const [activity, setActivity] = useState<Activity | null>({ message: 'Starter PDF Search' })
  const [queryError, setQueryError] = useState<string | null>(null)
  const [hasSearched, setHasSearched] = useState(false)
  const [isPending, startTransition] = useTransition()
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const startedRef = useRef(false)

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    if (!window.okPdf) {
      setError('Programforbindelsen kunne ikke indlæses. Genstart PDF Search eller installér den nyeste version.')
      setActivity(null)
      return
    }
    void (async () => {
      setActivity({ message: 'Indlæser lokalt indeks' })
      const stored = await window.okPdf.loadIndex()
      const initialFolder = stored?.folder ?? await window.okPdf.getDefaultFolder() ?? ''
      if (!initialFolder) {
        setActivity(null)
        return
      }
      try {
        await loadFolder(initialFolder, stored)
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : 'Dokumentmappen kunne ikke indlæses.')
        setActivity(null)
      }
    })()
  }, [])

  useEffect(() => {
    if (!documentMenu) return
    const close = (): void => setDocumentMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('blur', close)
    }
  }, [documentMenu])

  async function benchmarkInSteps(engine: DocumentSearch, truthSet: TruthSet): Promise<void> {
    let result: BenchmarkResult = { total: truthSet.records.length, top1: 0, top3: 0, failures: [] }
    setBenchmark(result)
    for (let index = 0; index < truthSet.records.length; index += 1) {
      setActivity({ message: 'Kontrollerer sandhedssæt', current: index + 1, total: truthSet.records.length })
      const part = engine.benchmark([truthSet.records[index]])
      result = {
        total: truthSet.records.length,
        top1: result.top1 + part.top1,
        top3: result.top3 + part.top3,
        failures: [...result.failures, ...part.failures]
      }
      setBenchmark(result)
      await yieldToUi()
    }
  }

  async function loadFolder(selected: string, previous: StoredIndex | null): Promise<void> {
    if (!window.okPdf) return
    const reusable = previous?.folder === selected ? previous : null
    setActivity({ message: 'Kontrollerer dokumentmappe' })
    const scanned = await window.okPdf.scanFolder(selected, reusable?.files)
    const [truthSet, overview] = await Promise.all([
      window.okPdf.loadTruths(selected),
      window.okPdf.loadOverview(selected)
    ])
    setFolder(selected)
    setFiles(scanned)
    setTruths(truthSet)
    setError(null)

    let next = reusable
    if (!indexIsCurrent(reusable, selected, scanned)) {
      setIsIndexing(true)
      const added = scanned.filter((file) => !reusable?.files.some((known) => known.path === file.path && known.sha256 === file.sha256)).length
      const removed = reusable?.files.filter((known) => !scanned.some((file) => file.path === known.path)).length ?? 0
      setActivity({ message: `${added ? `${added} tilføjet/ændret` : ''}${added && removed ? ' · ' : ''}${removed ? `${removed} fjernet` : ''}` || 'Opretter lokalt indeks' })
      try {
        next = await buildIndex(selected, scanned, reusable, setProgress)
        await window.okPdf.saveIndex(next)
      } finally {
        setIsIndexing(false)
        setProgress(null)
      }
    }

    if (!next) {
      setActivity(null)
      return
    }
    setIndex(next)
    setActivity({ message: 'Klargør søgning' })
    await yieldToUi()
    const engine = new DocumentSearch(next.fragments, truthSet.records, overview.entries)
    setSearch(engine)
    setResults([])
    await benchmarkInSteps(engine, truthSet)
    setActivity(null)
  }

  async function chooseFolder(): Promise<void> {
    if (!window.okPdf) {
      setError('Programforbindelsen er ikke tilgængelig.')
      return
    }
    const selected = await window.okPdf.chooseFolder()
    if (!selected) return
    try {
      await loadFolder(selected, index)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Mappen kunne ikke læses.')
      setActivity(null)
    }
  }

  async function indexDocuments(): Promise<void> {
    if (!window.okPdf) {
      setError('Programforbindelsen er ikke tilgængelig.')
      return
    }
    if (!folder) return
    setIsIndexing(true)
    setError(null)
    try {
      await loadFolder(folder, index)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Indekseringen mislykkedes.')
    } finally {
      setIsIndexing(false)
      setProgress(null)
    }
  }

  function submitSearch(event: React.FormEvent): void {
    event.preventDefault()
    if (!search) return
    if (!parseQuery(query).valid) {
      setQueryError('Luk citationstegnet for at søge efter en eksakt frase.')
      return
    }
    setQueryError(null)
    setHasSearched(true)
    startTransition(() => setResults(search.search(query, 20, enabledDocumentPaths())))
  }

  function enabledDocumentPaths(disabled = disabledDocuments): Set<string> {
    return new Set(files.filter((file) => !disabled.has(file.path)).map((file) => file.path))
  }

  function applyDisabledDocuments(next: Set<string>): void {
    setDisabledDocuments(next)
    localStorage.setItem(DISABLED_DOCUMENTS_KEY, JSON.stringify(Array.from(next)))
    if (search && hasSearched) {
      startTransition(() => setResults(search.search(query, 20, enabledDocumentPaths(next))))
    }
  }

  function toggleDocument(path: string): void {
    const next = new Set(disabledDocuments)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    applyDisabledDocuments(next)
  }

  function toggleFavorite(path: string): void {
    const next = new Set(favoriteDocuments)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    setFavoriteDocuments(next)
    localStorage.setItem(FAVORITE_DOCUMENTS_KEY, JSON.stringify(Array.from(next)))
    setDocumentMenu(null)
  }

  function openViewer(result: SearchResult, button: HTMLButtonElement): void {
    returnFocusRef.current = button
    setViewer({
      path: result.documentPath,
      title: result.documentName,
      page: result.physicalPage,
      provision: result.provision,
      query,
      source: result.source
    })
  }

  function closeViewer(): void {
    setViewer(null)
    requestAnimationFrame(() => returnFocusRef.current?.focus())
  }

  const indexedCount = index?.version === 2
    ? index.files.filter((indexed) => files.some((file) => file.sha256 === indexed.sha256)).length
    : 0
  const enabledCount = files.length - files.filter((file) => disabledDocuments.has(file.path)).length
  const favoriteFiles = files.filter((file) => favoriteDocuments.has(file.path))
  const otherFiles = files.filter((file) => !favoriteDocuments.has(file.path))
  const progressPercent = progress?.totalDocuments
    ? 100 * ((progress.currentDocument - 1) + (progress.totalPages ? progress.currentPage / progress.totalPages : 1)) / progress.totalDocuments
    : activity?.total ? 100 * (activity.current ?? 0) / activity.total : null

  const documentRow = (file: PdfFile): React.JSX.Element => {
    const favorite = favoriteDocuments.has(file.path)
    return (
      <div
        className={`document-row ${disabledDocuments.has(file.path) ? 'document-row-disabled' : ''}`}
        key={file.path}
        onContextMenu={(event) => {
          event.preventDefault()
          setDocumentMenu({ path: file.path, x: Math.min(event.clientX, window.innerWidth - 210), y: Math.min(event.clientY, window.innerHeight - 58) })
        }}
      >
        <input
          type="checkbox"
          checked={!disabledDocuments.has(file.path)}
          onChange={() => toggleDocument(file.path)}
          aria-label={`Medtag ${file.name} i søgning`}
        />
        <span className="pdf-tag">PDF</span>
        <span className="document-name" title={file.name}>{file.name.replace(/\.pdf$/i, '')}</span>
        <button
          className={`favorite-button ${favorite ? 'favorite-button-active' : ''}`}
          onClick={() => toggleFavorite(file.path)}
          aria-label={`${favorite ? 'Fjern' : 'Tilføj'} ${file.name} ${favorite ? 'fra' : 'til'} favoritter`}
          title={favorite ? 'Fjern fra favoritter' : 'Tilføj til favoritter'}
        >{favorite ? '★' : '☆'}</button>
      </div>
    )
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <div className="brand-mark">§</div>
          <div><strong>PDF Search</strong><span>Lovgivning og standarder</span></div>
        </div>
        <div className="offline-banner">
          <span className="offline-dot" />
          <div><strong>OFFLINE DOKUMENTSØGNING</strong><span>Ingen data forlader computeren</span></div>
        </div>
      </header>
      {(activity || isIndexing) && (
        <div className="global-progress" role="status" aria-live="polite">
          <div className="global-progress-copy">
            <strong>{progress?.message ?? activity?.message}</strong>
            <span>{progress ? `${progress.documentName} · ${progress.currentDocument}/${progress.totalDocuments}${progress.totalPages ? ` · side ${progress.currentPage}/${progress.totalPages}` : ''}` : activity?.total ? `${activity.current}/${activity.total}` : ''}</span>
          </div>
          <div className={`global-progress-track ${progressPercent === null ? 'global-progress-indeterminate' : ''}`}>
            <span style={progressPercent === null ? undefined : { width: `${Math.min(100, progressPercent)}%` }} />
          </div>
        </div>
      )}

      <main className="workspace">
        <aside className="library-panel">
          <div className="panel-heading">
            <span className="eyebrow">Bibliotek</span>
            <h2>{files.length} dokumenter</h2>
          </div>
          <button className="secondary-button full-width" disabled={Boolean(activity) || isIndexing} onClick={() => void chooseFolder()}>Vælg PDF-mappe</button>
          <div className="folder-path" title={folder}>{folder || 'Ingen mappe valgt'}</div>
          <div className="index-summary">
            <span><strong>{indexedCount}</strong> indekseret</span>
            <span><strong>{files.length - indexedCount}</strong> afventer</span>
          </div>
          <div className="truth-summary" title={truths.warnings.join(' ')}>
            <div><span>Sandhedssæt</span><strong>{truths.records.length}</strong></div>
            <div><span>Top-1</span><strong>{benchmark.total ? `${benchmark.top1}/${benchmark.total}` : '–'}</strong></div>
            <div><span>Top-3</span><strong>{benchmark.total ? `${benchmark.top3}/${benchmark.total}` : '–'}</strong></div>
          </div>
          <button className="primary-button full-width" disabled={!folder || isIndexing || Boolean(activity)} onClick={() => void indexDocuments()}>
            {isIndexing ? 'Indekserer…' : indexedCount === files.length && files.length ? 'Opdatér indeks' : 'Indeksér dokumenter'}
          </button>
          {progress && (
            <div className="progress-card">
              <div className="progress-label"><strong>{progress.documentName}</strong><span>{progress.currentDocument}/{progress.totalDocuments}</span></div>
              <div className="progress-track"><span style={{ width: `${progress.totalPages ? progress.currentPage / progress.totalPages * 100 : 100}%` }} /></div>
              <small>{progress.message}{progress.totalPages ? ` · side ${progress.currentPage}/${progress.totalPages}` : ''}</small>
            </div>
          )}
          <div className="document-filter-heading">
            <strong>Søg i dokumenter</strong>
            <span>{enabledCount}/{files.length} valgt</span>
          </div>
          <div className="document-filter-actions">
            <button onClick={() => applyDisabledDocuments(new Set())}>Vælg alle</button>
            <button onClick={() => applyDisabledDocuments(new Set(files.map((file) => file.path)))}>Fravælg alle</button>
          </div>
          <div className="document-list">
            {favoriteFiles.length > 0 && <div className="document-section-heading"><span>★</span> Favoritter</div>}
            {favoriteFiles.map(documentRow)}
            {favoriteFiles.length > 0 && otherFiles.length > 0 && <div className="document-section-heading">Øvrige dokumenter</div>}
            {otherFiles.map(documentRow)}
          </div>
        </aside>

        <section className="search-panel">
          <div className="search-intro">
            <span className="eyebrow">Find bestemmelsen</span>
            <h1>Søg i dine dokumenter</h1>
            <p>Skriv et eksamensspørgsmål eller nogle få faglige nøgleord.</p>
            <span className="search-scope">Søger i {enabledCount} af {files.length} dokumenter</span>
          </div>
          <form className="search-form" onSubmit={submitSearch}>
            <input
              aria-label="Søgetekst"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                if (queryError) setQueryError(null)
              }}
              placeholder={'Fx SPD offentlig lader eller "transiente overspændinger"'}
              aria-invalid={Boolean(queryError)}
            />
            <button className="search-button" disabled={!search || !query.trim() || isPending || enabledCount === 0}>Søg</button>
          </form>
          {queryError && <div className="query-error">{queryError}</div>}
          {!search && !isIndexing && (
            <div className="empty-state">
              <span className="empty-number">01</span>
              <div><strong>Indeksér biblioteket for at begynde</strong><p>PDF-tekst og OCR behandles lokalt på denne computer.</p></div>
            </div>
          )}
          {error && <div className="error-card">{error}</div>}
          {search && results.length === 0 && query && !isPending && (
            <div className="no-results">{enabledCount ? 'Ingen resultater endnu. Prøv søgningen eller justér dine nøgleord.' : 'Vælg mindst ét dokument i biblioteket.'}</div>
          )}
          <div className="results-list">
            {results.map((result, position) => (
              <article className="result-card" key={result.id}>
                <div className="result-rank">{String(position + 1).padStart(2, '0')}</div>
                <div className="result-content">
                  <h3>{result.documentName}</h3>
                  <div className="result-meta">
                    <span>PDF-side <strong>{result.physicalPage}</strong></span>
                    <span>Bestemmelse <strong>{result.provision}</strong></span>
                    {result.source === 'ocr' && <span className="ocr-label">OCR</span>}
                  </div>
                </div>
                <div className="confidence" aria-label={`Matchsikkerhed ${result.confidence} procent`}>
                  <strong>{result.confidence}%</strong><span>matchsikkerhed</span>
                </div>
                <button className="open-button" onClick={(event) => openViewer(result, event.currentTarget)}>
                  Åbn PDF
                </button>
              </article>
            ))}
          </div>
        </section>
        {viewer ? (
          <PdfViewer key={`${viewer.path}:${viewer.page}:${viewer.provision}`} {...viewer} initialPage={viewer.page} onClose={closeViewer} />
        ) : (
          <aside className="viewer-shell viewer-placeholder" aria-label="PDF-fremviser">
            <div>
              <strong>PDF-FREMVISER</strong>
              <span>Åbn en PDF fra søgeresultaterne</span>
            </div>
          </aside>
        )}
      </main>
      {documentMenu && (
        <div className="document-context-menu" role="menu" style={{ left: documentMenu.x, top: documentMenu.y }}>
          <button role="menuitem" onClick={() => toggleFavorite(documentMenu.path)}>
            <span>{favoriteDocuments.has(documentMenu.path) ? '☆' : '★'}</span>
            {favoriteDocuments.has(documentMenu.path) ? 'Fjern fra favoritter' : 'Tilføj til favoritter'}
          </button>
        </div>
      )}
      <footer className="app-footer"><span>PDF Search · Lokalt indeks</span><span>{index ? `Senest opdateret ${new Date(index.createdAt).toLocaleString('da-DK')}` : 'Ikke indekseret'}</span></footer>
    </div>
  )
}
