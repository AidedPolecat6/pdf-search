import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

const port = 9333
const executable = resolve('dist/win-unpacked/PDF Search.exe')
const child = spawn(executable, [`--remote-debugging-port=${port}`], { stdio: 'ignore' })

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))

async function fetchJson(path) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}${path}`)
      if (response.ok) return response.json()
    } catch {
      // The debugging endpoint starts shortly after the Electron process.
    }
    await delay(250)
  }
  throw new Error('Den pakkede app åbnede ikke debugging-endpointet.')
}

function cdp(webSocketUrl, method, params = {}) {
  return new Promise((resolveCall, rejectCall) => {
    const socket = new WebSocket(webSocketUrl)
    const timer = setTimeout(() => {
      socket.close()
      rejectCall(new Error(`CDP-kaldet ${method} fik timeout.`))
    }, 30_000)
    socket.addEventListener('open', () => socket.send(JSON.stringify({ id: 1, method, params })))
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data))
      if (message.id !== 1) return
      clearTimeout(timer)
      socket.close()
      if (message.error) rejectCall(new Error(message.error.message))
      else resolveCall(message.result)
    })
    socket.addEventListener('error', () => {
      clearTimeout(timer)
      rejectCall(new Error(`Kunne ikke forbinde til ${method}.`))
    })
  })
}

try {
  let page
  for (let attempt = 0; attempt < 20 && !page; attempt += 1) {
    const pages = await fetchJson('/json')
    page = pages.find((candidate) => candidate.type === 'page')
    if (!page) await delay(250)
  }
  if (!page) throw new Error('PDF Search-vinduet blev ikke fundet.')
  await delay(1_000)

  const expression = `(() => {
    const chooseButton = [...document.querySelectorAll('button')].find((button) => button.textContent.includes('Vælg PDF-mappe'));
    const searchInput = document.querySelector('input[aria-label="Søgetekst"]');
    return {
      api: typeof window.okPdf,
      chooseFolder: typeof window.okPdf?.chooseFolder,
      chooseButtonDisabled: chooseButton?.disabled,
      searchInputDisabled: searchInput?.disabled,
      brand: document.querySelector('.brand-block strong')?.textContent,
      brandMark: document.querySelector('.brand-mark')?.textContent,
      startupError: document.querySelector('.error-card')?.textContent ?? null
    };
  })()`
  const result = await cdp(page.webSocketDebuggerUrl, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  })
  const value = result.result.value
  if (value.api !== 'object' || value.chooseFolder !== 'function') throw new Error('Preload-API blev ikke indlæst.')
  if (value.searchInputDisabled !== false) throw new Error('Søgefeltet er deaktiveret.')
  if (value.brand !== 'PDF Search' || value.brandMark !== '§') throw new Error(`Forkert branding: ${JSON.stringify(value)}`)
  if (value.startupError) throw new Error(`Brugerfladen viser en opstartsfejl: ${value.startupError}`)

  let ready = false
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const readiness = await cdp(page.webSocketDebuggerUrl, 'Runtime.evaluate', {
      expression: `!document.querySelector('.global-progress') && !document.querySelector('.error-card')`,
      returnByValue: true
    })
    ready = readiness.result.value
    if (ready) break
    await delay(1_000)
  }
  if (!ready) {
    const diagnostics = await cdp(page.webSocketDebuggerUrl, 'Runtime.evaluate', {
      expression: `({ activity: document.querySelector('.global-progress-copy')?.textContent, error: document.querySelector('.error-card')?.textContent, documents: document.querySelector('.panel-heading h2')?.textContent, indexButton: document.querySelector('.primary-button')?.textContent })`,
      returnByValue: true
    })
    throw new Error(`Søgningen blev ikke klar efter startup: ${JSON.stringify(diagnostics.result.value)}`)
  }
  const controlsReady = await cdp(page.webSocketDebuggerUrl, 'Runtime.evaluate', {
    expression: `[...document.querySelectorAll('button')].find((button) => button.textContent.includes('Vælg PDF-mappe'))?.disabled === false`,
    returnByValue: true
  })
  if (!controlsReady.result.value) throw new Error('Mappeknappen forblev deaktiveret efter startup.')
  const emptyViewer = await cdp(page.webSocketDebuggerUrl, 'Runtime.evaluate', {
    expression: `(() => {
      const placeholder = document.querySelector('.viewer-placeholder');
      const rect = placeholder?.getBoundingClientRect();
      return { text: placeholder?.textContent, width: rect?.width, right: rect?.right, viewport: innerWidth };
    })()`,
    returnByValue: true
  })
  if (!emptyViewer.result.value.text?.includes('PDF-FREMVISER') || !emptyViewer.result.value.text?.includes('Åbn en PDF fra søgeresultaterne') || emptyViewer.result.value.width < 600 || emptyViewer.result.value.width >= emptyViewer.result.value.viewport || Math.abs(emptyViewer.result.value.right - emptyViewer.result.value.viewport) > 16) {
    throw new Error(`Den tomme PDF-fremviser er forkert: ${JSON.stringify(emptyViewer.result.value)}`)
  }

  await cdp(page.webSocketDebuggerUrl, 'Runtime.evaluate', {
    expression: `(() => {
      const input = document.querySelector('input[aria-label="Søgetekst"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'SPD offentlig elbil lader');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`
  })
  await delay(250)
  await cdp(page.webSocketDebuggerUrl, 'Runtime.evaluate', {
    expression: `document.querySelector('.search-button').click()`
  })
  await delay(500)
  const searchResult = await cdp(page.webSocketDebuggerUrl, 'Runtime.evaluate', {
    expression: `(() => {
      const card = document.querySelector('.result-card');
      return card ? {
        title: card.querySelector('h3')?.textContent,
        metadata: card.querySelector('.result-meta')?.textContent
      } : null;
    })()`,
    returnByValue: true
  })
  const firstResult = searchResult.result.value
  if (!firstResult?.title?.includes('DS-HD') || !firstResult?.metadata?.includes('802') || !firstResult?.metadata?.includes('722.443.4')) {
    throw new Error(`Forkert første søgeresultat: ${JSON.stringify(firstResult)}`)
  }
  await cdp(page.webSocketDebuggerUrl, 'Runtime.evaluate', {
    expression: `document.querySelector('.result-card .open-button').click()`
  })
  let viewer
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await delay(1_000)
    const viewerResult = await cdp(page.webSocketDebuggerUrl, 'Runtime.evaluate', {
      expression: `(() => ({
        status: document.querySelector('.highlight-status')?.textContent,
        boxes: document.querySelectorAll('.pdf-highlight-box').length,
        yellow: document.querySelectorAll('.pdf-highlight-query').length,
        blue: document.querySelectorAll('.pdf-highlight-synonym').length,
        page: document.querySelector('.viewer-title span')?.textContent,
        error: document.querySelector('.viewer-stage .error-card')?.textContent,
        geometry: (() => {
          const rect = document.querySelector('.viewer-shell')?.getBoundingClientRect();
          return rect ? { width: rect.width, right: rect.right, viewport: innerWidth } : null;
        })(),
        diagnostics: (() => {
          const status = document.querySelector('.highlight-status');
          return status ? {
            items: status.dataset.textItems,
            selected: status.dataset.selectedItems,
            anchor: status.dataset.anchorFound
          } : null;
        })()
      }))()`,
      returnByValue: true
    })
    viewer = viewerResult.result.value
    if (viewer?.boxes > 0 || viewer?.error) break
  }
  if (!viewer?.status?.includes('markeret') || viewer?.yellow < 1 || viewer?.blue < 1 || !viewer?.page?.includes('802') || viewer?.geometry?.width >= viewer?.geometry?.viewport || Math.abs(viewer?.geometry?.right - viewer?.geometry?.viewport) > 16) {
    throw new Error(`PDF-markeringen blev ikke vist korrekt: ${JSON.stringify(viewer)}`)
  }
  const truthResult = await cdp(page.webSocketDebuggerUrl, 'Runtime.evaluate', {
    expression: `[...document.querySelectorAll('.truth-summary div')].map((item) => item.textContent)`,
    returnByValue: true
  })
  const truthSummary = truthResult.result.value
  if (!truthSummary?.includes('Sandhedssæt15') || !truthSummary?.includes('Top-115/15') || !truthSummary?.includes('Top-315/15')) {
    throw new Error(`Sandhedssættet blev ikke indlæst korrekt: ${JSON.stringify(truthSummary)}`)
  }
  await cdp(page.webSocketDebuggerUrl, 'Runtime.evaluate', {
    expression: `document.querySelector('.highlight-toggle').click()`
  })
  await delay(200)
  const hiddenHighlight = await cdp(page.webSocketDebuggerUrl, 'Runtime.evaluate', {
    expression: `({ boxes: document.querySelectorAll('.pdf-highlight-box').length, label: document.querySelector('.highlight-toggle')?.textContent })`,
    returnByValue: true
  })
  if (hiddenHighlight.result.value.boxes !== 0 || !hiddenHighlight.result.value.label?.includes('Vis markering')) {
    throw new Error(`Markeringsknappen skjulte ikke markeringen: ${JSON.stringify(hiddenHighlight.result.value)}`)
  }
  await cdp(page.webSocketDebuggerUrl, 'Runtime.evaluate', {
    expression: `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', bubbles: true }))`
  })
  await delay(200)
  const shownByKeyboard = await cdp(page.webSocketDebuggerUrl, 'Runtime.evaluate', {
    expression: `document.querySelectorAll('.pdf-highlight-box').length`,
    returnByValue: true
  })
  if (shownByKeyboard.result.value < 1) throw new Error('M-genvejen viste ikke markeringen.')
  await cdp(page.webSocketDebuggerUrl, 'Runtime.evaluate', {
    expression: `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`
  })
  await delay(200)
  const closedViewer = await cdp(page.webSocketDebuggerUrl, 'Runtime.evaluate', {
    expression: `({ pdfOpen: Boolean(document.querySelector('.viewer-title')), placeholder: document.querySelector('.viewer-placeholder')?.textContent, focusReturned: document.activeElement?.classList.contains('open-button'), filters: document.querySelectorAll('.document-row input[type="checkbox"]').length, favoriteButtons: document.querySelectorAll('.favorite-button').length })`,
    returnByValue: true
  })
  if (closedViewer.result.value.pdfOpen || !closedViewer.result.value.placeholder?.includes('PDF-FREMVISER') || !closedViewer.result.value.focusReturned || closedViewer.result.value.filters < 1 || closedViewer.result.value.favoriteButtons !== closedViewer.result.value.filters) {
    throw new Error(`Escape eller dokumentfiltre fejlede: ${JSON.stringify(closedViewer.result.value)}`)
  }
  await cdp(page.webSocketDebuggerUrl, 'Runtime.evaluate', {
    expression: `document.querySelector('.document-row').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }))`
  })
  await delay(100)
  const contextMenu = await cdp(page.webSocketDebuggerUrl, 'Runtime.evaluate', {
    expression: `document.querySelector('.document-context-menu')?.textContent`,
    returnByValue: true
  })
  if (!contextMenu.result.value?.includes('favoritter')) throw new Error('Favoritmenuen blev ikke vist ved højreklik.')
  console.log(JSON.stringify({ ...value, firstResult, viewer, truthSummary, keyboard: closedViewer.result.value }))

  const version = await fetchJson('/json/version')
  try {
    await cdp(version.webSocketDebuggerUrl, 'Browser.close')
  } catch {
    // Electron may close the socket before acknowledging Browser.close.
  }
} finally {
  await delay(500)
  if (child.exitCode === null) child.kill()
}
