import { spawn } from 'node:child_process'
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import assert from 'node:assert/strict'

const baseline = process.argv.includes('--baseline')
const executable = resolve(process.argv[2])
const folder = join(process.env.LOCALAPPDATA, 'Temp', 'opencode', baseline ? 'pdf-scroll-before' : 'pdf-scroll-after')
await mkdir(join(folder, 'PDF Search Data'), { recursive: true })
await copyFile(resolve('dist/current/PDF Search Data/document-index.json'), join(folder, 'PDF Search Data', 'document-index.json'))
const port = baseline ? 9661 : 9662
const child = spawn(executable, [...(process.argv.includes('--development') ? [resolve('out/main/index.js')] : []), `--remote-debugging-port=${port}`, '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows'], {
  env: { ...process.env, PORTABLE_EXECUTABLE_DIR: folder }, stdio: 'ignore'
})
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
let socket
let id = 0
const pending = new Map()
function call(method, params = {}) {
  return new Promise((resolveCall, reject) => {
    const number = ++id
    const timer = setTimeout(() => { pending.delete(number); reject(new Error(`Timeout: ${method}`)) }, 120000)
    pending.set(number, { resolve: result => { clearTimeout(timer); resolveCall(result) }, reject })
    socket.send(JSON.stringify({ id: number, method, params }))
  })
}
async function evaluate(expression) {
  const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
  return result.result.value
}
async function until(expression, message, attempts = 120) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await evaluate(expression)) return
    await delay(250)
  }
  console.log(await evaluate(`({ title:document.querySelector('.viewer-title span')?.textContent, height:document.querySelector('.viewer-stage')?.clientHeight, top:document.querySelector('.viewer-stage')?.scrollTop, window:[innerWidth,innerHeight], errors:window.viewerErrors, text:document.querySelector('.viewer-stage')?.textContent, pages:[...document.querySelectorAll('.pdf-page-surface')].map(e=>({page:e.dataset.pageNumber,height:e.clientHeight}))})`))
  throw new Error(message)
}
async function search(query) {
  await evaluate(`(() => {
    const input = document.querySelector('input[aria-label="Søgetekst"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(query)});
    input.dispatchEvent(new Event('input', { bubbles:true }));
  })()`)
  await delay(60)
  return evaluate(`(async () => {
    const start = performance.now();
    document.querySelector('.search-button').click();
    const computeMs = performance.now() - start;
    await new Promise(resolve => setTimeout(resolve, 100));
    return { query:${JSON.stringify(query)}, computeMs, settledMs:performance.now()-start,
      first:document.querySelector('.result-card .result-meta')?.textContent };
  })()`)
}
try {
  let target
  for (let attempt = 0; attempt < 100 && !target; attempt++) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(page => page.type === 'page') } catch {}
    if (!target) await delay(250)
  }
  assert(target, 'App did not start')
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }))
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data))
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    if (message.error) request.reject(new Error(message.error.message))
    else request.resolve(message.result)
  })
  await until(`document.querySelector('.search-button') && !document.querySelector('.global-progress') && !document.querySelector('.error-card')`, 'Search startup failed', 960)
  await evaluate(`window.viewerErrors = []; window.addEventListener('error', e => viewerErrors.push(e.message)); window.addEventListener('unhandledrejection', e => viewerErrors.push(String(e.reason)));`)
  const timings = []
  for (let round = 0; round < 3; round++) {
    for (const query of ['443.1', 'SPD offentlig elbil lader', 'selektivitet', 'jordforbindelse']) timings.push(await search(query))
  }
  await search('443.1')
  const opened = await evaluate(`(() => {
    const cards = [...document.querySelectorAll('.result-card')];
    const card = cards.find(card => card.querySelector('.result-meta')?.textContent.includes('173')) || cards[0];
    card.querySelector('.open-button').click();
    return card.querySelector('.result-meta').textContent;
  })()`)
  await until(`document.querySelectorAll('.pdf-highlight-box').length > 0`, 'Result highlight missing')
  const initial = await evaluate(`({ title:document.querySelector('.viewer-title span').textContent, top:document.querySelector('.viewer-stage').scrollTop, canvases:document.querySelectorAll('.viewer-stage canvas').length, highlights:document.querySelectorAll('.pdf-highlight-box').length })`)
  const viewerTimings = []
  for (let round = 0; round < 3; round++) {
    for (const query of ['443.1', 'SPD offentlig elbil lader', 'selektivitet', 'jordforbindelse']) viewerTimings.push(await search(query))
  }
  if (!baseline) {
    assert(initial.canvases <= 6)
    const originalPage = Number(initial.title.match(/PDF-side (\d+)/)[1])
    await evaluate(`document.querySelector('.viewer-stage').scrollTop += 2200`)
    await until(`!document.querySelector('.viewer-title span').textContent.includes('PDF-side ${originalPage} ')`, 'Scroll did not update page')
    await delay(800)
    assert(await evaluate(`document.querySelectorAll('.viewer-stage canvas').length <= 6 && !document.querySelector('.viewer-stage .error-card')`))
    const pageBeforeZoom = await evaluate(`document.querySelector('.viewer-title span').textContent`)
    for (let step = 0; step < 6; step++) {
      await evaluate(`document.querySelectorAll('.viewer-zoom-controls button')[${step % 2}].click()`)
      await delay(50)
    }
    await delay(600)
    assert.equal(await evaluate(`document.querySelector('.viewer-title span').textContent`), pageBeforeZoom)
    await evaluate(`document.querySelector('.viewer-stage').scrollTop = 0`)
    await until(`document.querySelector('.viewer-title span').textContent.includes('PDF-side 1 ')`, 'First page failed')
    await evaluate(`document.querySelectorAll('.viewer-page-controls button')[1].click()`)
    await until(`document.querySelector('.viewer-title span').textContent.includes('PDF-side 2 ')`, 'Next button failed')
    await evaluate(`document.querySelectorAll('.viewer-page-controls button')[0].click()`)
    await until(`document.querySelector('.viewer-title span').textContent.includes('PDF-side 1 ')`, 'Previous button failed')
    await evaluate(`document.querySelector('.viewer-stage').scrollTop = document.querySelector('.viewer-stage').scrollHeight`)
    await delay(800)
    assert(await evaluate(`document.querySelectorAll('.viewer-page-controls button')[1].disabled`), 'Last page failed')
    await evaluate(`document.querySelector('.viewer-stage').scrollTop = ${initial.top}`)
    await until(`document.querySelectorAll('.pdf-highlight-box').length > 0`, 'Returning to search highlight failed')
    const beforeToggle = await evaluate(`document.querySelector('.viewer-stage').scrollTop`)
    await evaluate(`document.querySelector('.highlight-toggle').click()`)
    await delay(200)
    assert.equal(await evaluate(`document.querySelectorAll('.pdf-highlight-box').length`), 0)
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'m',bubbles:true}))`)
    await delay(200)
    assert.equal(await evaluate(`document.querySelector('.viewer-stage').scrollTop`), beforeToggle, 'Toggling highlights moved reading position')
    assert(await evaluate(`document.querySelectorAll('.pdf-highlight-box').length > 0`))
    const screenshot = await call('Page.captureScreenshot', { format: 'png' })
    await writeFile(join(folder, 'viewer.png'), Buffer.from(screenshot.data, 'base64'))
    await call('Emulation.setDeviceMetricsOverride', { width: 800, height: 900, deviceScaleFactor: 1, mobile: false })
    await delay(300)
    assert(await evaluate(`document.querySelector('.viewer-stage').clientHeight < innerHeight && document.querySelectorAll('.viewer-stage canvas').length <= 6`), 'Narrow window rendered too many pages')
    await call('Emulation.clearDeviceMetricsOverride')
    await evaluate(`document.querySelectorAll('.viewer-zoom-controls button')[1].click(); document.querySelector('[aria-label="Luk dokument"]').click()`)
    await delay(300)
    assert.equal(await evaluate(`document.querySelectorAll('.viewer-stage canvas').length`), 0)
  }
  const errors = await evaluate('window.viewerErrors')
  assert.deepEqual(errors, [])
  const report = { baseline, opened, initial, timings, viewerTimings, errors }
  await writeFile(join(folder, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
} finally {
  socket?.close()
  if (child.exitCode === null) child.kill()
}
