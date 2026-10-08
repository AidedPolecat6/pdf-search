import { readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import ExcelJS from 'exceljs'

const dataFolder = resolve('data')
const fileName = (await readdir(dataFolder)).find((name) => !name.startsWith('~$') && /^sandheder.*\.xlsx$/i.test(name))
if (!fileName) throw new Error('Sandhedsarket blev ikke fundet i data-mappen.')

const workbook = new ExcelJS.Workbook()
await workbook.xlsx.readFile(resolve(dataFolder, fileName))
const sheet = workbook.worksheets[0]
if (!sheet) throw new Error('Sandhedsarket indeholder ingen fane.')

const quote = (value) => `"${String(value ?? '').replace(/\r?\n/g, ' ').replace(/"/g, '""')}"`
const rows = []
for (let rowNumber = 1; rowNumber <= sheet.actualRowCount; rowNumber += 1) {
  rows.push(Array.from({ length: sheet.actualColumnCount }, (_, index) => quote(sheet.getCell(rowNumber, index + 1).text)).join(','))
}

const output = resolve(dataFolder, fileName.replace(/\.xlsx$/i, '.csv'))
await writeFile(output, `\uFEFF${rows.join('\n')}\n`, 'utf8')
console.log(`Eksporterede ${sheet.actualRowCount - 1} sandheder til ${output}`)
