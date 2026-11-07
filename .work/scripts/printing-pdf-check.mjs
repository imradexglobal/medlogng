import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { inflateSync } from 'node:zlib'
import { chromium } from '@playwright/test'
import {
  BASE_PRINT_TOP_MARGIN_MM,
  buildLetterheadNameCss,
  buildPrintOffsetCss,
} from '../../src/features/printing/domain.js'

const root = process.cwd()
const outDir = resolve(root, '.work/printing-pdf-qa')
const browserPath = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const appCss = await readFile(resolve(root, 'src/app.css'), 'utf8')
await mkdir(outDir, { recursive: true })

function textPositionsFromTopPt(pdf) {
  const source = pdf.toString('latin1')
  const streams = []
  let cursor = 0
  while ((cursor = source.indexOf('stream', cursor)) >= 0) {
    let start = cursor + 6
    if (source[start] === '\r' && source[start + 1] === '\n') start += 2
    else if (source[start] === '\n') start += 1
    else { cursor = start; continue }
    const end = source.indexOf('endstream', start)
    if (end < 0) break
    const rawEnd = end - (source[end - 1] === '\n' ? 1 : 0)
    try { streams.push(inflateSync(pdf.subarray(start, rawEnd)).toString('latin1')) } catch { /* uncompressed/non-content stream */ }
    cursor = end + 9
  }

  const positions = []
  for (const stream of streams.filter((item) => /Tm/.test(item))) {
    // The last 3.125x transform in each page's content stream is the print
    // sheet. Its first text baseline is the page-one/page-two marker.
    const matrices = [...stream.matchAll(/3\.125 0 0 3\.125 212\.5 (-?[\d.]+) cm/g)]
    if (!matrices.length) continue
    const matrix = matrices[matrices.length - 1]
    const text = stream.slice(matrix.index + matrix[0].length)
    const tm = text.match(/1 0 0 -1 [\d.]+ ([\d.]+) Tm/)
    if (!tm) continue
    const cssY = Number(matrix[1]) + 3.125 * Number(tm[1])
    // Chromium's outer transform maps CSS print coordinates to PDF points.
    positions.push(0.24 * cssY)
  }
  return positions
}

const browser = await chromium.launch({ executablePath: browserPath, headless: true })
const outputPositions = new Map()
try {
  for (const offset of [0, 10, 25, 40]) {
    const settings = { letterhead_adjustment_enabled: offset > 0, top_offset_mm: offset }
    const css = [buildPrintOffsetCss(settings), buildLetterheadNameCss(settings)].filter(Boolean).join('\n')
    const letterheadClass = settings.letterhead_adjustment_enabled ? ' printing-preprinted-letterhead' : ''
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>${appCss}</style><style>${css}</style></head>
      <body class="printing${letterheadClass}"><div id="print-root"><div class="print-sheet">
        <h1>OFFSET_QA_${offset}_PAGE_1</h1><p>First page content marker</p>
        <div style="break-before:page;page-break-before:always"><h1>OFFSET_QA_${offset}_PAGE_2</h1><p>Second page content marker</p></div>
      </div><div id="headerName" class="p-hospital" style="position:absolute;top:-999px">ORG_HEADER_QA</div><div id="footerName" class="p-org-name" style="position:absolute;top:-999px">ORG_FOOTER_QA</div></div></body></html>`
    const page = await browser.newPage()
    await page.setContent(html, { waitUntil: 'load' })
    await page.emulateMedia({ media: 'print' })
    const nameDisplays = await page.evaluate(() => ({
      header: getComputedStyle(document.getElementById('headerName')).display,
      footer: getComputedStyle(document.getElementById('footerName')).display,
    }))
    const shouldHideName = settings.letterhead_adjustment_enabled
    assert.equal(nameDisplays.header === 'none', shouldHideName, 'hospital header follows letterhead mode')
    assert.equal(nameDisplays.footer === 'none', shouldHideName, 'hospital footer follows letterhead mode')
    const file = resolve(outDir, `offset-${offset}mm.pdf`)
    const pdf = await page.pdf({ path: file, format: 'A4', printBackground: true, preferCSSPageSize: true })
    const pdfText = pdf.toString('latin1')
    const pageCount = (pdfText.match(/\/Type\s*\/Page\b/g) || []).length
    assert.equal(pageCount, 2, `${offset}mm print should retain two pages`)
    assert.ok(pdf.subarray(0, 5).toString() === '%PDF-', 'output is a valid PDF')
    const positions = textPositionsFromTopPt(pdf)
    assert.equal(positions.length, 2, 'both page content baselines must be measurable')
    assert.ok(Math.abs(positions[0] - positions[1]) < 1, 'the same content starts at the same position on both pages')
    outputPositions.set(offset, positions[0])
    console.log(`${offset} mm: A4 PDF, ${pageCount} pages; content baseline ${positions[0].toFixed(2)} pt from top; configured page margin ${BASE_PRINT_TOP_MARGIN_MM + offset} mm`)
    await page.close()
  }
} finally {
  await browser.close()
}

const base = outputPositions.get(0)
for (const offset of [10, 25, 40]) {
  const expectedPt = offset * 72 / 25.4
  const actualPt = outputPositions.get(offset) - base
  assert.ok(Math.abs(actualPt - expectedPt) < 0.75, `${offset} mm should move the PDF content by ${expectedPt.toFixed(2)} pt (actual ${actualPt.toFixed(2)} pt)`)
  console.log(`${offset} mm: measured +${actualPt.toFixed(2)} pt (expected ${expectedPt.toFixed(2)} pt)`)
}
