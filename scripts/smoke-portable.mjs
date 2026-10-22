import { spawn } from 'node:child_process'
import { access, copyFile, mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'

const port = 9555
const source = resolve('dist/PDF Search Portable 0.1.0.exe')
const testFolder = resolve('dist/portable-smoke')
const executable = resolve(testFolder, 'PDF Search Portable.exe')
const dataFolder = resolve(testFolder, 'PDF Search Data')
const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))

await rm(testFolder, { recursive: true, force: true })
await mkdir(testFolder, { recursive: true })
await copyFile(source, executable)
const child = spawn(executable, [`--remote-debugging-port=${port}`], { stdio: 'ignore' })

async function fetchJson(path) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}${path}`)
      if (response.ok) return response.json()
    } catch {
      // Portable Electron extraction takes longer than the unpacked build.
    }
    await delay(250)
  }
  throw new Error('Den portable app startede ikke debugging-endpointet.')
}

function cdp(webSocketUrl, method, params = {}) {
  return new Promise((resolveCall, rejectCall) => {
    const socket = new WebSocket(webSocketUrl)
    const timer = setTimeout(() => {
      socket.close()
      rejectCall(new Error(`${method} fik timeout.`))
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
  })
}

try {
  const pages = await fetchJson('/json')
  const page = pages.find((candidate) => candidate.type === 'page')
  if (!page) throw new Error('Det portable PDF Search-vindue blev ikke fundet.')
  await delay(1_000)
  const result = await cdp(page.webSocketDebuggerUrl, 'Runtime.evaluate', {
    expression: `(() => {
      const choose = [...document.querySelectorAll('button')].find((button) => button.textContent.includes('Vælg PDF-mappe'));
      return {
        brand: document.querySelector('.brand-block strong')?.textContent,
        placeholder: document.querySelector('.viewer-placeholder')?.textContent,
        documents: document.querySelector('.panel-heading h2')?.textContent,
        chooseEnabled: choose?.disabled === false,
        error: document.querySelector('.error-card')?.textContent ?? null
      };
    })()`,
    returnByValue: true
  })
  await access(dataFolder)
  const value = result.result.value
  if (value.brand !== 'PDF Search' || !value.placeholder?.includes('PDF-FREMVISER') || value.documents !== '0 dokumenter' || !value.chooseEnabled || value.error) {
    throw new Error(`Den portable app startede forkert: ${JSON.stringify(value)}`)
  }
  console.log(JSON.stringify({ ...value, dataFolderCreated: true }))

  const version = await fetchJson('/json/version')
  try {
    await cdp(version.webSocketDebuggerUrl, 'Browser.close')
  } catch {
    // Electron may close before acknowledging Browser.close.
  }
} finally {
  await delay(500)
  if (child.exitCode === null) child.kill()
  await delay(500)
  await rm(testFolder, { recursive: true, force: true })
}
