export const BASE_PRINT_TOP_MARGIN_MM = 15
export const MAX_TOP_PRINTING_OFFSET_MM = 100

export const DEFAULT_PRINTING_SETTINGS = Object.freeze({
  letterhead_adjustment_enabled: false,
  top_offset_mm: 0,
})

export function normalizePrintingSettings(value) {
  const rawOffset = Number(value?.top_offset_mm)
  const topOffsetMm = Number.isFinite(rawOffset) && rawOffset >= 0 && rawOffset <= MAX_TOP_PRINTING_OFFSET_MM
    ? rawOffset
    : 0
  return {
    letterhead_adjustment_enabled: value?.letterhead_adjustment_enabled === true,
    top_offset_mm: topOffsetMm,
  }
}

export function validatePrintingSettings(value) {
  const enabled = value?.letterhead_adjustment_enabled === true
  const rawOffset = value?.top_offset_mm
  const offset = rawOffset === '' || rawOffset == null ? NaN : Number(rawOffset)
  if (!Number.isFinite(offset) || offset < 0 || offset > MAX_TOP_PRINTING_OFFSET_MM) {
    throw new Error(`Enter a top printing offset from 0 to ${MAX_TOP_PRINTING_OFFSET_MM} mm.`)
  }
  return {
    letterhead_adjustment_enabled: enabled,
    top_offset_mm: offset,
  }
}

export function printPageTopMarginMm(settings) {
  const normalized = normalizePrintingSettings(settings)
  return BASE_PRINT_TOP_MARGIN_MM + (
    normalized.letterhead_adjustment_enabled ? normalized.top_offset_mm : 0
  )
}

// The application's baseline @page rule uses 15mm top, 18mm left/right and
// 20mm bottom. Override only the top margin so page width and horizontal layout
// remain unchanged. Because this is a page rule, it applies once to every page.
export function buildPrintOffsetCss(settings) {
  const normalized = normalizePrintingSettings(settings)
  if (!normalized.letterhead_adjustment_enabled || normalized.top_offset_mm === 0) return ''
  return `@media print { @page { margin-top: ${printPageTopMarginMm(normalized)}mm; } }`
}

export function buildLetterheadNameCss(settings) {
  const normalized = normalizePrintingSettings(settings)
  if (!normalized.letterhead_adjustment_enabled) return ''
  return '@media print { body.printing-preprinted-letterhead #print-root .p-hospital, body.printing-preprinted-letterhead #print-root .p-org-name { display: none !important; } }'
}
