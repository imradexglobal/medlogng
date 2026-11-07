import assert from 'node:assert/strict'
import {
  BASE_PRINT_TOP_MARGIN_MM,
  DEFAULT_PRINTING_SETTINGS,
  MAX_TOP_PRINTING_OFFSET_MM,
  buildLetterheadNameCss,
  buildPrintOffsetCss,
  normalizePrintingSettings,
  printPageTopMarginMm,
  validatePrintingSettings,
} from '../../src/features/printing/domain.js'

assert.deepEqual(DEFAULT_PRINTING_SETTINGS, {
  letterhead_adjustment_enabled: false,
  top_offset_mm: 0,
})
assert.equal(printPageTopMarginMm(DEFAULT_PRINTING_SETTINGS), BASE_PRINT_TOP_MARGIN_MM)
assert.equal(buildPrintOffsetCss(DEFAULT_PRINTING_SETTINGS), '', 'disabled printing injects no CSS')
assert.equal(buildLetterheadNameCss(DEFAULT_PRINTING_SETTINGS), '', 'plain-paper mode keeps generated hospital names')

for (const offset of [10, 25, 40]) {
  const settings = validatePrintingSettings({ letterhead_adjustment_enabled: true, top_offset_mm: String(offset) })
  assert.equal(settings.top_offset_mm, offset)
  assert.equal(printPageTopMarginMm(settings), BASE_PRINT_TOP_MARGIN_MM + offset)
  const css = buildPrintOffsetCss(settings)
  assert.ok(css.includes(`margin-top: ${BASE_PRINT_TOP_MARGIN_MM + offset}mm`), `${offset}mm is added to the existing top margin`)
  assert.ok(css.includes('@page'), 'the offset is page-level and therefore applies to each page')
  assert.ok(!css.includes('margin-left') && !css.includes('margin-right'), 'horizontal margins remain untouched')
}

const zero = validatePrintingSettings({ letterhead_adjustment_enabled: true, top_offset_mm: '0' })
assert.equal(printPageTopMarginMm(zero), BASE_PRINT_TOP_MARGIN_MM)
assert.equal(buildPrintOffsetCss(zero), '', 'zero offset is the existing position')
assert.ok(buildLetterheadNameCss(zero).includes('.p-hospital'), 'pre-printed mode omits the generated hospital header even when offset is zero')
assert.ok(buildLetterheadNameCss(zero).includes('.p-org-name'), 'pre-printed mode omits generated hospital-name footer fields')

const disabledWithSavedOffset = normalizePrintingSettings({ letterhead_adjustment_enabled: false, top_offset_mm: 25 })
assert.equal(printPageTopMarginMm(disabledWithSavedOffset), BASE_PRINT_TOP_MARGIN_MM, 'disabled setting ignores but preserves a stored offset')
assert.equal(buildLetterheadNameCss(disabledWithSavedOffset), '', 'disabling letterhead preserves generated hospital names')

for (const invalid of ['abc', '', -1, MAX_TOP_PRINTING_OFFSET_MM + 1, Infinity]) {
  assert.throws(
    () => validatePrintingSettings({ letterhead_adjustment_enabled: true, top_offset_mm: invalid }),
    /offset from 0 to/,
    `rejects invalid offset ${String(invalid)}`,
  )
}
assert.equal(normalizePrintingSettings({ top_offset_mm: -5 }).top_offset_mm, 0, 'invalid remote data is safely ignored')

console.log('printing settings: all assertions passed')
