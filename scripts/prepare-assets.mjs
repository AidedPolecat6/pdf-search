import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const publicDir = resolve(root, 'src/renderer/public')
const ocrDir = resolve(publicDir, 'ocr')

rmSync(ocrDir, { recursive: true, force: true })
mkdirSync(resolve(ocrDir, 'core'), { recursive: true })
mkdirSync(resolve(ocrDir, 'lang'), { recursive: true })

cpSync(resolve(root, 'node_modules/tesseract.js/dist/worker.min.js'), resolve(ocrDir, 'worker.min.js'))
cpSync(resolve(root, 'node_modules/tesseract.js-core'), resolve(ocrDir, 'core'), { recursive: true })
cpSync(
  resolve(root, 'node_modules/@tesseract.js-data/dan/4.0.0_best_int/dan.traineddata.gz'),
  resolve(ocrDir, 'lang/dan.traineddata.gz')
)
cpSync(
  resolve(root, 'node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz'),
  resolve(ocrDir, 'lang/eng.traineddata.gz')
)

console.log('Offline OCR assets prepared.')
