// Allergy Tag Input Component - reusable tag input with suggestions
// Usage: createAllergyTagInput(containerElement, { value, suggestions, onChange, placeholder, name })
// value: array of strings (e.g., ['Penicillin', 'Latex'])
// suggestions: array of strings for autocomplete
// onChange: callback(valueArray) called when tags change
// name: form field name for FormData collection

import { esc } from '../utils/sanitize.js'

// Common allergy suggestions (can be extended from patient data)
export const DEFAULT_ALLERGY_SUGGESTIONS = [
  'Penicillin', 'Amoxicillin', 'Cephalosporins', 'Sulfa drugs', 'Aspirin', 'NSAIDs',
  'Ibuprofen', 'Naproxen', 'Codeine', 'Morphine', 'Latex', 'Eggs', 'Peanuts',
  'Tree nuts', 'Shellfish', 'Fish', 'Soy', 'Wheat', 'Dairy', 'Sesame',
  'Contrast dye (iodine)', 'Local anesthetics', 'Tetracycline', 'Erythromycin',
  'Ciprofloxacin', 'Metronidazole', 'ACE inhibitors', 'Beta blockers',
  'Insulin', 'Heparin', 'Warfarin', 'Propofol', 'Thiopental', 'Succinylcholine',
  'Atropine', 'Epinephrine', 'Diazepam', 'Lorazepam', 'Midazolam', 'Fentanyl',
  'Ketamine', 'Nitrous oxide', 'Sevoflurane', 'Isoflurane', 'Propofol'
]

function normalizeAllergy(s) {
  return String(s || '').trim().replace(/\s+/g, ' ')
}

function uniqueAllergies(arr) {
  const seen = new Set()
  return arr.filter(a => {
    const key = a.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function createAllergyTagInput(container, options = {}) {
  const {
    value = [],
    suggestions = DEFAULT_ALLERGY_SUGGESTIONS,
    onChange,
    placeholder = 'Type allergy and press Enter',
    name = 'allergy_tags',
    disabled = false,
  } = options

  const tags = [...value].map(normalizeAllergy).filter(Boolean)
  let allSuggestions = [...suggestions]
  let suggestionIndex = -1
  let isFocused = false
  let inputEl = null
  let hiddenInputEl = null
  let wrapperEl = null
  let suggestionBoxEl = null
  let tagListEl = null
  let onOutsidePointer = null

  function getFilteredSuggestions(queryText) {
    const q = normalizeAllergy(queryText).toLowerCase()
    const excludeLower = new Set(tags.map(t => t.toLowerCase()))
    let list = allSuggestions.filter(s => !excludeLower.has(s.toLowerCase()))
    if (q) {
      const starts = []
      const contains = []
      for (const s of list) {
        const sLower = s.toLowerCase()
        if (sLower.startsWith(q)) starts.push(s)
        else if (sLower.includes(q)) contains.push(s)
      }
      list = [...starts.sort((a, b) => a.localeCompare(b)), ...contains.sort((a, b) => a.localeCompare(b))]
    } else {
      list = [...list].sort((a, b) => a.localeCompare(b))
    }
    return list.slice(0, 8)
  }

  function highlightMatch(text, queryText) {
    const q = normalizeAllergy(queryText)
    if (!q) return esc(text)
    const lower = text.toLowerCase()
    const idx = lower.indexOf(q.toLowerCase())
    if (idx === -1) return esc(text)
    return esc(text.slice(0, idx)) + '<strong>' + esc(text.slice(idx, idx + q.length)) + '</strong>' + esc(text.slice(idx + q.length))
  }

  function buildHTML() {
    const tagHtml = tags.map((tag, i) =>
      `<span class="allergy-tag" data-index="${i}">
        <span class="tag-text">${esc(tag)}</span>
        <button type="button" class="tag-remove" aria-label="Remove ${esc(tag)}" ${disabled ? 'disabled' : ''}>×</button>
      </span>`
    ).join('')

    return `
      <div class="allergy-tag-input ${isFocused ? 'focused' : ''} ${disabled ? 'disabled' : ''}" role="combobox" aria-expanded="${isFocused ? 'true' : 'false'}" aria-haspopup="listbox">
        <div class="tag-list" aria-live="polite">${tagHtml}</div>
        <input type="text" class="tag-input-field" name="${name}" placeholder="${esc(placeholder)}" ${disabled ? 'disabled' : ''} autocomplete="off" spellcheck="false" aria-label="Add allergy" />
        <input type="hidden" name="${name}_json" value="${esc(JSON.stringify(tags))}" />
      </div>
      <div class="allergy-suggestions" role="listbox" style="display:none"></div>
    `
  }

  function initDOM() {
    container.innerHTML = buildHTML()
    wrapperEl = container.querySelector('.allergy-tag-input')
    inputEl = container.querySelector('.tag-input-field')
    hiddenInputEl = container.querySelector('input[type="hidden"]')
    tagListEl = container.querySelector('.tag-list')
    suggestionBoxEl = container.querySelector('.allergy-suggestions')
    bindEvents()
  }

  // Single add path for every trigger (suggestion pointerdown / click, Enter).
  // Dedupes case-insensitively and returns whether a tag was actually added.
  function addTag(raw) {
    const val = normalizeAllergy(raw)
    if (!val || tags.some(t => t.toLowerCase() === val.toLowerCase())) return false
    tags.push(val)
    inputEl.value = ''
    suggestionIndex = -1
    notifyChange()
    return true
  }

  function bindEvents() {
    if (!inputEl) return

    // Click on wrapper focuses input
    wrapperEl.addEventListener('click', (e) => {
      if (e.target === wrapperEl || e.target === tagListEl) {
        inputEl.focus()
      }
    })

    inputEl.addEventListener('focus', () => {
      isFocused = true
      suggestionIndex = -1
      updateFocusState()
      updateSuggestions()
    })

    // While the pointer is down ON the suggestion list (touch: pointerdown
    // precedes the tap's blur/click and may still turn into a scroll), the
    // blur timer must NOT hide the list out from under the incoming click.
    let pointerOnList = false

    inputEl.addEventListener('blur', (e) => {
      // Delay to allow click on suggestions (the list is a SIBLING of the
      // input box, so :focus-within never covers it).
      setTimeout(() => {
        if (pointerOnList) return
        if (!wrapperEl?.matches(':focus-within')) {
          isFocused = false
          suggestionIndex = -1
          updateFocusState()
          hideSuggestions()
        }
      }, 150)
    })

    // Add tag on Enter — an arrow-highlighted suggestion wins over the typed
    // text, so "press Enter to pick it" behaves the way it reads on screen.
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        const items = suggestionBoxEl?.querySelectorAll('.suggestion-item')
        const picked = (suggestionIndex >= 0 && items && items[suggestionIndex])
          ? items[suggestionIndex].textContent
          : inputEl.value
        addTag(picked)
      } else if (e.key === 'Backspace' && !inputEl.value && tags.length > 0) {
        e.preventDefault()
        tags.pop()
        notifyChange()
      } else if (e.key === 'ArrowDown' && isFocused) {
        e.preventDefault()
        const items = suggestionBoxEl?.querySelectorAll('.suggestion-item')
        if (items && items.length > 0) {
          suggestionIndex = Math.min(suggestionIndex + 1, items.length - 1)
          updateSuggestionSelection()
        }
      } else if (e.key === 'ArrowUp' && isFocused) {
        e.preventDefault()
        suggestionIndex = Math.max(suggestionIndex - 1, -1)
        updateSuggestionSelection()
      } else if (e.key === 'Escape') {
        inputEl.blur()
      } else {
        suggestionIndex = -1
      }
    })

    inputEl.addEventListener('input', () => {
      suggestionIndex = -1
      updateSuggestions()
    })

    // Remove tag buttons - use event delegation on tagListEl
    tagListEl.addEventListener('click', (e) => {
      const removeBtn = e.target.closest('.tag-remove')
      if (removeBtn) {
        e.stopPropagation()
        const tagEl = removeBtn.closest('.allergy-tag')
        const idx = Number(tagEl?.dataset.index)
        if (!isNaN(idx)) {
          tags.splice(idx, 1)
          notifyChange()
        }
      }
    })

    // Pick a suggestion.
    //   mouse/pen — pointerdown fires BEFORE the input would blur, so the tag
    //               is committed right there; preventDefault keeps focus (and
    //               the list) exactly where it was. No race at all.
    //   touch     — pointerdown can still turn into a scroll of the list, so
    //               the add waits for the tap's click event; the blur timer
    //               above skips hiding while the pointer is down on the list
    //               so the list survives long enough for the click to land
    //               (previously it went display:none first and the tap hit
    //               nothing — "select does not add").
    // The dedupe in addTag makes it safe if both paths run (compat mouse
    // events after a touch tap).
    const suggestionAt = (e) => e.target.closest('.suggestion-item')

    suggestionBoxEl?.addEventListener('pointerdown', (e) => {
      const item = suggestionAt(e)
      if (!item) return
      if (e.pointerType === 'touch') { pointerOnList = true; return }
      addTag(item.textContent)
      e.preventDefault() // keep focus in the input; list stays open
    })
    suggestionBoxEl?.addEventListener('click', (e) => {
      const item = suggestionAt(e)
      pointerOnList = false
      if (!item) return
      addTag(item.textContent)
      inputEl.focus()
    })

    // Tapping/clicking anywhere outside the field closes the list — also
    // covers a touch-scroll that started on the list and produced no click.
    // Registered on focus, released in hideSuggestions, so nothing leaks
    // across the many modal instances this component is mounted into.
    onOutsidePointer = (e) => {
      pointerOnList = false
      if (!container.contains(e.target)) hideSuggestions()
    }
    inputEl.addEventListener('focus', () => {
      document.removeEventListener('pointerdown', onOutsidePointer, true)
      document.addEventListener('pointerdown', onOutsidePointer, true)
    })
  }

  function updateFocusState() {
    if (!wrapperEl) return
    wrapperEl.classList.toggle('focused', isFocused)
    wrapperEl.setAttribute('aria-expanded', isFocused ? 'true' : 'false')
  }

  function updateSuggestions() {
    if (!isFocused || !suggestionBoxEl) {
      hideSuggestions()
      return
    }
    const queryText = inputEl?.value || ''
    const filtered = getFilteredSuggestions(queryText)
    if (filtered.length === 0) {
      hideSuggestions()
      return
    }
    suggestionBoxEl.innerHTML = filtered
      .map((s, i) => `<div class="suggestion-item ${i === suggestionIndex ? 'selected' : ''}" data-index="${i}" role="option">${highlightMatch(s, queryText)}</div>`).join('')
    suggestionBoxEl.style.display = 'block'
  }

  function hideSuggestions() {
    // Release the outside-tap listener too — it only exists to close a list
    // that is still up after a blurred input (touch), and hideSuggestions is
    // the single place every hide path goes through.
    if (onOutsidePointer) document.removeEventListener('pointerdown', onOutsidePointer, true)
    if (suggestionBoxEl) suggestionBoxEl.style.display = 'none'
  }

  function updateSuggestionSelection() {
    suggestionBoxEl?.querySelectorAll('.suggestion-item').forEach((el, i) => {
      el.classList.toggle('selected', i === suggestionIndex)
    })
  }

  function updateTagList() {
    if (!tagListEl) return
    tagListEl.innerHTML = tags.map((tag, i) =>
      `<span class="allergy-tag" data-index="${i}">
        <span class="tag-text">${esc(tag)}</span>
        <button type="button" class="tag-remove" aria-label="Remove ${esc(tag)}" ${disabled ? 'disabled' : ''}>×</button>
      </span>`
    ).join('')
  }

  function notifyChange() {
    if (hiddenInputEl) hiddenInputEl.value = JSON.stringify(tags)
    onChange?.([...tags])
    updateTagList()
    updateSuggestions()
  }

  function setAllSuggestions(newList) {
    const seen = new Set()
    allSuggestions = []
    for (const s of [...newList]) {
      const n = normalizeAllergy(s)
      if (!n) continue
      const key = n.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      allSuggestions.push(n)
    }
    updateSuggestions()
  }

  // Initial render
  initDOM()

  // Public API
  return {
    getValue: () => [...tags],
    setValue: (newTags) => {
      tags.length = 0
      tags.push(...newTags.map(normalizeAllergy).filter(Boolean))
      updateTagList()
      updateSuggestions()
      if (hiddenInputEl) hiddenInputEl.value = JSON.stringify(tags)
    },
    updateSuggestions: setAllSuggestions,
    destroy: () => {
      if (onOutsidePointer) document.removeEventListener('pointerdown', onOutsidePointer, true)
      container.innerHTML = ''
    },
  }
}

export function parseAllergyString(str) {
  if (!str) return []
  if (Array.isArray(str)) return str.map(normalizeAllergy).filter(Boolean)
  if (typeof str !== 'string') return []
  if (str === 'None known') return []
  return str.split(/[,;]/).map(normalizeAllergy).filter(Boolean)
}

// Helper to convert array to display string (for backward compat)
export function allergyArrayToString(arr) {
  if (!arr || arr.length === 0) return 'None known'
  return uniqueAllergies(arr).join(', ')
}