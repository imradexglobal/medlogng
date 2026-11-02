// Consultation microphone capture is local. Cloud transcription is a separate,
// clinician-triggered action and is never queued for automatic reconnection.
const MAX_RECORDING_MS = 5 * 60 * 1000

function saveInsertionPoint(field) {
  if (field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement) return { start: field.selectionStart ?? field.value.length, end: field.selectionEnd ?? field.value.length }
  const selection = window.getSelection()
  if (!selection?.rangeCount) return null
  const range = selection.getRangeAt(0)
  return field.contains(range.startContainer) ? range.cloneRange() : null
}

function applyText(field, value, mode, point) {
  const text = String(value || '')
  if (field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement) {
    if (mode === 'replace') field.value = text
    else if (mode === 'append') field.value += (field.value && !/\s$/.test(field.value) ? '\n' : '') + text
    else field.setRangeText(text, point?.start ?? field.selectionStart ?? field.value.length, point?.end ?? field.selectionEnd ?? field.value.length, 'end')
    field.dispatchEvent(new Event('input', { bubbles: true })); field.focus(); return
  }
  if (mode === 'replace') field.textContent = text
  else if (mode === 'append') { const p = document.createElement('p'); p.textContent = text; field.append(p) }
  else if (point && field.contains(point.startContainer)) { const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(point); document.execCommand('insertText', false, text) }
  else { const p = document.createElement('p'); p.textContent = text; field.append(p) }
  field.dispatchEvent(new Event('input', { bubbles: true })); field.focus()
}

export function attachSpeechInput(field, { getOrgId, getPatientId, getEncounterId, disabled = false, onTranscriptReady } = {}) {
  if (!field?.parentNode) return () => {}
  const widget = document.createElement('div')
  widget.className = 'speech-control'
  widget.innerHTML =
    '<div class="speech-control-row">' +
      '<button type="button" class="speech-record" aria-label="Record speech" title="Record locally"><svg aria-hidden="true" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="2" width="6" height="12" rx="3"></rect><path d="M5 10a7 7 0 0 0 14 0M12 17v5m-4 0h8"></path></svg><span class="speech-record-label">Record</span></button>' +
      '<button type="button" class="speech-transcribe" hidden>Transcribe recording</button>' +
      '<select class="speech-pending-select" aria-label="Choose a saved recording" hidden></select>' +
      '<span class="speech-status" role="status" aria-live="polite"></span>' +
      '<button type="button" class="speech-cancel" hidden>Cancel</button>' +
    '</div>' +
    '<div class="speech-review" hidden>' +
      '<label class="speech-review-label">Review transcript before inserting</label>' +
      '<textarea class="input speech-transcript" rows="3" aria-label="Review transcript"></textarea>' +
      '<div class="speech-review-actions">' +
        '<button type="button" class="btn ghost sm" data-speech-insert>Insert at cursor</button>' +
        '<button type="button" class="btn ghost sm" data-speech-append>Append</button>' +
        '<button type="button" class="btn sm" data-speech-replace>Replace field</button>' +
        '<button type="button" class="btn ghost sm" data-speech-ai>Use for clinical draft</button>' +
      '</div>' +
    '</div>'
  field.insertAdjacentElement('afterend', widget)

  const recordButton = widget.querySelector('.speech-record')
  const recordLabel = widget.querySelector('.speech-record-label')
  const transcribeButton = widget.querySelector('.speech-transcribe')
  const pendingSelect = widget.querySelector('.speech-pending-select')
  const cancelButton = widget.querySelector('.speech-cancel')
  const status = widget.querySelector('.speech-status')
  const review = widget.querySelector('.speech-review')
  const transcript = widget.querySelector('.speech-transcript')
  const insertButton = widget.querySelector('[data-speech-insert]')
  const appendButton = widget.querySelector('[data-speech-append]')
  const replaceButton = widget.querySelector('[data-speech-replace]')
  const aiButton = widget.querySelector('[data-speech-ai]')
  aiButton.hidden = typeof onTranscriptReady !== 'function'
  let stream = null, recorder = null, chunks = [], recording = false, destroyed = false
  let pendingId = '', pendingBlob = null, pendingPersistent = false, backend = null, uploadAbort = null, savedPoint = null, startedAt = 0, elapsedTimer = null, healthTimer = null
  let captureBinding = null, captureUid = ''
  let pendingRecords = []
  const pendingBlobs = new Map()

  const binding = () => ({ orgId: String(getOrgId?.() || ''), patientId: String(getPatientId?.() || ''), encounterId: String(getEncounterId?.() || '') })
  const setStatus = (text, kind = '') => { status.textContent = text; status.dataset.kind = kind }
  function renderPendingOptions() {
    pendingSelect.replaceChildren()
    for (const row of pendingRecords) {
      const option = document.createElement('option')
      option.value = row.id
      option.textContent = 'Recording · ' + new Date(row.createdAt).toLocaleString()
      pendingSelect.append(option)
    }
    pendingSelect.hidden = pendingRecords.length < 2
    if (pendingId && pendingRecords.some((row) => row.id === pendingId)) pendingSelect.value = pendingId
  }
  const canRecord = () => !disabled && window.location.protocol === 'https:' && window.isSecureContext && !!navigator.mediaDevices?.getUserMedia && !!window.MediaRecorder
  function refreshRecordControl() { recordButton.disabled = !recording && !canRecord(); recordButton.title = canRecord() ? 'Record on this device' : 'Microphone recording requires HTTPS and a supported browser.' }
  function stopTracks() { if (elapsedTimer) clearInterval(elapsedTimer); elapsedTimer = null; if (stream) stream.getTracks().forEach((track) => track.stop()); stream = null }
  function restoreReadyState() {
    recording = false; recorder = null; chunks = []; stopTracks(); recordButton.classList.remove('is-recording')
    recordButton.setAttribute('aria-label', 'Record speech'); recordLabel.textContent = 'Record'; cancelButton.hidden = true; refreshRecordControl()
  }
  async function refreshBackend() {
    if (destroyed) return
    backend = null
    try {
      const { auth } = await import('../firebase.js')
      const { getSpeechBackend } = await import('../services/speechTransport.js')
      backend = await getSpeechBackend({ orgId: binding().orgId, user: auth.currentUser })
    } catch { backend = null }
    transcribeButton.hidden = !(pendingId && backend)
    if (pendingId && !backend) setStatus(pendingPersistent ? 'Recording saved securely on this device. Online transcription is unavailable; reconnect and choose Transcribe recording.' : 'Recording is kept in this open consultation only. Keep this page open until transcription is available.', 'warning')
    else if (pendingId && backend) setStatus(pendingPersistent ? 'Recording saved securely on this device. Choose Transcribe recording when ready.' : 'Recording is ready in this open consultation. Choose Transcribe recording when ready.', 'success')
  }
  async function saveRecording(blob, ids = binding(), uid = '') {
    try {
      const { auth } = await import('../firebase.js')
      uid = uid || auth.currentUser?.uid || ''
      if (!uid || !ids.orgId || !ids.patientId || !ids.encounterId) throw new Error('Open a patient-linked consultation and sign in before recording.')
      const { savePendingSpeech } = await import('../services/pendingSpeech.js')
      pendingBlob = blob
      pendingId = await savePendingSpeech(blob, { uid, ...ids })
      pendingBlobs.set(pendingId, blob)
      pendingPersistent = true
      pendingRecords = [{ id: pendingId, createdAt: Date.now() }, ...pendingRecords.filter((row) => row.id !== pendingId)]
      renderPendingOptions()
      await refreshBackend()
    } catch (error) {
      pendingId = 'memory-only'; pendingPersistent = false
      pendingBlobs.set(pendingId, blob)
      pendingRecords = [{ id: pendingId, createdAt: Date.now() }, ...pendingRecords.filter((row) => row.id !== pendingId)]
      renderPendingOptions()
      setStatus((error?.message || 'Secure local storage is unavailable.') + ' The recording remains in this open consultation; keep the page open.', 'warning')
      await refreshBackend()
    }
  }
  async function startRecording() {
    if (!canRecord() || recording) return
    captureBinding = binding()
    if (!captureBinding.orgId || !captureBinding.patientId || !captureBinding.encounterId) { setStatus('Open a patient-linked consultation before recording.', 'error'); return }
    try {
      const { auth } = await import('../firebase.js')
      captureUid = auth.currentUser?.uid || ''
      if (!captureUid) throw new Error('Sign in before recording.')
    } catch (error) { setStatus(error?.message || 'Sign in before recording.', 'error'); return }
    savedPoint = saveInsertionPoint(field); review.hidden = true; transcript.value = ''; setStatus('Requesting microphone…')
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
      const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find((type) => MediaRecorder.isTypeSupported?.(type))
      recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
      chunks = []; recorder.ondataavailable = (event) => { if (event.data?.size) chunks.push(event.data) }
      recorder.onerror = () => {
        const partial = new Blob(chunks, { type: recorder?.mimeType || mimeType || 'audio/webm' })
        const ids = captureBinding; const uid = captureUid
        restoreReadyState()
        if (partial.size) { setStatus('Microphone recording stopped unexpectedly. Keeping the captured audio locally.', 'warning'); void saveRecording(partial, ids, uid) }
        else setStatus('Microphone recording stopped unexpectedly.', 'error')
      }
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: recorder?.mimeType || mimeType || 'audio/webm' })
        const ids = captureBinding; const uid = captureUid
        restoreReadyState()
        if (blob.size) void saveRecording(blob, ids, uid)
        else setStatus('No audio was recorded. Check the microphone and try again.', 'error')
      }
      recorder.start(1000); recording = true; startedAt = Date.now(); recordButton.disabled = false
      recordButton.classList.add('is-recording'); recordButton.setAttribute('aria-label', 'Stop recording'); cancelButton.hidden = false; setStatus('Recording locally…')
      elapsedTimer = setInterval(() => {
        const seconds = Math.min(300, Math.floor((Date.now() - startedAt) / 1000))
        recordLabel.textContent = 'Stop · ' + Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0')
        if (seconds >= 300) recorder?.stop()
      }, 500)
    } catch (error) {
      restoreReadyState()
      setStatus(error?.name === 'NotAllowedError' ? 'Microphone permission was denied.' : error?.name === 'NotFoundError' ? 'No microphone was found.' : 'Could not start microphone recording.', 'error')
    }
  }
  function stopRecording() { if (recording && recorder?.state !== 'inactive') { setStatus('Saving recording securely on this device…'); recorder.stop() } }
  async function transcribe() {
    if (!pendingId || !backend) { await refreshBackend(); if (!backend) return }
    transcribeButton.disabled = true; cancelButton.hidden = false; setStatus('Sending recording for online transcription…')
    uploadAbort = new AbortController()
    try {
      const { auth } = await import('../firebase.js')
      const ids = binding()
      const { loadPendingSpeech, deletePendingSpeech } = await import('../services/pendingSpeech.js')
      const blob = pendingBlob || await loadPendingSpeech(pendingId, { uid: auth.currentUser?.uid, ...ids })
      const { transcribeRecording } = await import('../services/speechTransport.js')
      const result = await transcribeRecording({ backend, blob, signal: uploadAbort.signal, ...ids })
      transcript.value = result.text; review.hidden = false; transcript.focus()
      if (pendingPersistent) await deletePendingSpeech(pendingId, auth.currentUser.uid)
      pendingBlobs.delete(pendingId)
      pendingRecords = pendingRecords.filter((row) => row.id !== pendingId)
      pendingId = pendingRecords[0]?.id || ''; pendingBlob = null; pendingPersistent = !!pendingId
      renderPendingOptions(); transcribeButton.hidden = !(pendingId && backend); cancelButton.hidden = true
      const elapsed = Number.isFinite(result.processingMs) ? ' · ' + (result.processingMs / 1000).toFixed(1) + ' sec' : ''
      setStatus('Transcript ready — review before inserting. (' + result.model + elapsed + ')' + (pendingId ? ' Another saved recording is ready.' : ''), 'success')
    } catch (error) {
      if (error?.name === 'AbortError') setStatus('Transcription cancelled. The encrypted recording remains on this device.', 'warning')
      else setStatus(error?.message || 'Transcription failed. The encrypted recording remains on this device.', 'error')
      await refreshBackend()
    } finally { uploadAbort = null; transcribeButton.disabled = false; cancelButton.hidden = !recording }
  }
  async function cancelCurrent() {
    if (recording) {
      if (recorder?.state !== 'inactive') { recorder.onstop = null; recorder.stop() }
      restoreReadyState(); chunks = []; setStatus('Recording cancelled.')
      return
    }
    uploadAbort?.abort()
  }

  recordButton.onclick = () => recording ? stopRecording() : void startRecording()
  transcribeButton.onclick = () => void transcribe()
  pendingSelect.onchange = () => {
    pendingId = pendingSelect.value
    pendingPersistent = pendingId !== 'memory-only'; pendingBlob = pendingBlobs.get(pendingId) || null
    void refreshBackend()
  }
  cancelButton.onclick = () => void cancelCurrent()
  insertButton.onclick = () => { applyText(field, transcript.value, 'insert', savedPoint); review.hidden = true; setStatus('Transcript inserted. Review and save the note when ready.', 'success') }
  appendButton.onclick = () => { applyText(field, transcript.value, 'append', savedPoint); review.hidden = true; setStatus('Transcript appended. Review and save the note when ready.', 'success') }
  replaceButton.onclick = () => { applyText(field, transcript.value, 'replace', savedPoint); review.hidden = true; setStatus('Field replaced. Review and save the note when ready.', 'success') }
  aiButton.onclick = () => { const text = transcript.value.trim(); if (!text) { setStatus('Review transcript is empty.', 'error'); return }; onTranscriptReady?.(text); setStatus('Transcript sent to the clinical draft review panel.', 'success') }
  refreshRecordControl()

  void (async () => {
    try {
      const { auth } = await import('../firebase.js')
      const ids = binding()
      const user = auth.currentUser
      if (user && ids.orgId && ids.patientId && ids.encounterId) {
        const { findPendingSpeech } = await import('../services/pendingSpeech.js')
        const records = await findPendingSpeech({ uid: user.uid, ...ids })
        if (records.length) { pendingRecords = records; pendingId = records[0].id; pendingPersistent = true; renderPendingOptions(); setStatus('A saved recording is available. It will not be uploaded until you choose Transcribe recording.', 'warning') }
      }
    } catch { /* local encrypted storage may be disabled by the browser */ }
    await refreshBackend()
    healthTimer = setInterval(() => void refreshBackend(), 30_000)
  })()
  const online = () => { void refreshBackend() }
  window.addEventListener('online', online)
  return () => {
    destroyed = true; if (healthTimer) clearInterval(healthTimer); window.removeEventListener('online', online)
    uploadAbort?.abort()
    if (recording && recorder?.state !== 'inactive') recorder.stop()
    else stopTracks()
    widget.remove()
  }
}
