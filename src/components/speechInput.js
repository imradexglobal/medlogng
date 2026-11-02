// Reusable, review-before-insert speech input for narrative clinical fields.
// Audio is recorded locally, then sent only to the authenticated same-origin
// Host speech endpoint. It is never saved with the encounter automatically.
const MAX_RECORDING_MS = 5 * 60 * 1000
const POLL_MS = 1800

function requestId() {
  return crypto.randomUUID()
}

function saveInsertionPoint(field) {
  if (field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement) {
    return { start: field.selectionStart ?? field.value.length, end: field.selectionEnd ?? field.value.length }
  }
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
    else {
      const start = point?.start ?? field.selectionStart ?? field.value.length
      const end = point?.end ?? field.selectionEnd ?? start
      field.setRangeText(text, start, end, 'end')
    }
    field.dispatchEvent(new Event('input', { bubbles: true }))
    field.focus()
    return
  }
  if (mode === 'replace') {
    field.textContent = text
  } else if (mode === 'append') {
    const p = document.createElement('p')
    p.textContent = text
    field.append(p)
  } else if (point && field.contains(point.startContainer)) {
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(point)
    document.execCommand('insertText', false, text)
  } else {
    const p = document.createElement('p')
    p.textContent = text
    field.append(p)
  }
  field.dispatchEvent(new Event('input', { bubbles: true }))
  field.focus()
}

export function attachSpeechInput(field, { getOrgId, disabled = false } = {}) {
  if (!field || !field.parentNode) return () => {}
  const widget = document.createElement('div')
  widget.className = 'speech-control'
  widget.innerHTML =
    '<div class="speech-control-row">' +
      '<button type="button" class="speech-record" aria-label="Record speech" title="Record speech">' +
        '<svg aria-hidden="true" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="2" width="6" height="12" rx="3"></rect><path d="M5 10a7 7 0 0 0 14 0M12 17v5m-4 0h8"></path></svg> <span class="speech-record-label">Dictate</span></button>' +
      '<button type="button" class="speech-retry" hidden>Retry last recording</button>' +
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
      '</div>' +
    '</div>'
  if (field.matches('textarea,input')) field.insertAdjacentElement('afterend', widget)
  else field.insertAdjacentElement('afterend', widget)

  const recordButton = widget.querySelector('.speech-record')
  const recordLabel = widget.querySelector('.speech-record-label')
  const retryButton = widget.querySelector('.speech-retry')
  const cancelButton = widget.querySelector('.speech-cancel')
  const status = widget.querySelector('.speech-status')
  const review = widget.querySelector('.speech-review')
  const transcript = widget.querySelector('.speech-transcript')
  const insertButton = widget.querySelector('[data-speech-insert]')
  const appendButton = widget.querySelector('[data-speech-append]')
  const replaceButton = widget.querySelector('[data-speech-replace]')
  let stream = null
  let recorder = null
  let chunks = []
  let lastRecording = null
  let upload = null
  let jobId = ''
  let orgId = ''
  let savedPoint = null
  let startedAt = 0
  let elapsedTimer = null
  let pollTimer = null
  let destroyed = false
  let recording = false
  let canceling = false
  let savedJobKey = ''

  function setStatus(text, kind = '') {
    status.textContent = text
    status.dataset.kind = kind
  }

  function stopTracks() {
    if (elapsedTimer) clearInterval(elapsedTimer)
    elapsedTimer = null
    if (stream) stream.getTracks().forEach((track) => track.stop())
    stream = null
  }

  function resetCapture() {
    stopTracks()
    recorder = null
    chunks = []
    recording = false
    recordButton.disabled = disabled
    recordButton.classList.remove('is-recording')
    recordButton.setAttribute('aria-label', 'Record speech')
    recordLabel.textContent = 'Dictate'
    cancelButton.hidden = true
  }

  function stopPolling() {
    if (pollTimer) clearTimeout(pollTimer)
    pollTimer = null
  }

  function rememberJob(id, activeOrg, uid) {
    savedJobKey = 'medilogng.speechJob.' + uid + '.' + String(field.id || 'narrative')
    try { localStorage.setItem(savedJobKey, JSON.stringify({ id, orgId: activeOrg, uid, createdAt: Date.now() })) } catch {}
  }

  function forgetJob() {
    if (savedJobKey) {
      try { localStorage.removeItem(savedJobKey) } catch {}
    }
    savedJobKey = ''
  }

  async function authHeaders() {
    const { auth } = await import('../firebase.js')
    const token = await auth.currentUser?.getIdToken()
    if (!token) throw new Error('Sign in again before recording a note.')
    return { authorization: 'Bearer ' + token, 'x-medilog-client': 'medilogng-web' }
  }

  function pollJob(id, activeOrg) {
    if (destroyed) return
    pollTimer = setTimeout(async () => {
      try {
        const { auth } = await import('../firebase.js')
        const freshToken = await auth.currentUser?.getIdToken()
        if (!freshToken) throw new Error('Sign in again to retrieve the transcript.')
        const response = await fetch(window.location.origin + '/speech/jobs/' + encodeURIComponent(id) +
          '?orgId=' + encodeURIComponent(activeOrg), {
          headers: { authorization: 'Bearer ' + freshToken, 'x-medilog-client': 'medilogng-web' },
          cache: 'no-store',
        })
        const data = await response.json().catch(() => ({}))
        if (!response.ok || !data.job) throw new Error(data.error || 'Could not check transcription status.')
        const job = data.job
        if (job.status === 'queued' || job.status === 'processing') {
          setStatus(job.status === 'queued'
            ? 'Waiting in queue' + (job.queuePosition ? ' · position ' + job.queuePosition : '')
            : 'Transcribing on Host…')
          pollJob(id, activeOrg)
          return
        }
        if (job.status === 'complete') {
          review.hidden = false
          transcript.value = job.text || ''
          transcript.focus()
          setStatus('Transcript ready — review before inserting', 'success')
          lastRecording = null
          jobId = ''
          cancelButton.hidden = true
          return
        }
        setStatus(job.error || (job.status === 'cancelled' ? 'Transcription cancelled.' : 'Transcription failed.'), 'error')
        jobId = ''
        forgetJob()
        retryButton.hidden = !lastRecording
        cancelButton.hidden = true
      } catch (error) {
        setStatus(error?.message || 'Could not retrieve the transcript.', 'error')
        jobId = ''
        forgetJob()
        retryButton.hidden = !lastRecording
        cancelButton.hidden = true
      }
    }, POLL_MS)
  }

  async function uploadRecording(blob) {
    canceling = false
    retryButton.hidden = true
    try {
      const headers = await authHeaders()
      const activeOrg = String(getOrgId?.() || '')
      if (!activeOrg) throw new Error('Select a hospital before transcribing.')
      orgId = activeOrg
      const reqId = requestId()
      setStatus('Uploading recording…')
      cancelButton.hidden = false
      upload = new XMLHttpRequest()
      const result = await new Promise((resolve, reject) => {
        upload.open('POST', window.location.origin + '/speech/jobs?orgId=' + encodeURIComponent(activeOrg))
        upload.setRequestHeader('authorization', headers.authorization)
        upload.setRequestHeader('x-medilog-client', headers['x-medilog-client'])
        upload.setRequestHeader('x-speech-request-id', reqId)
        upload.setRequestHeader('content-type', blob.type || 'application/octet-stream')
        upload.upload.onprogress = (event) => {
          if (event.lengthComputable) setStatus('Uploading · ' + Math.round(event.loaded / event.total * 100) + '%')
        }
        upload.onload = () => {
          let data = {}
          try { data = JSON.parse(upload.responseText || '{}') } catch {}
          if (upload.status >= 200 && upload.status < 300 && data.job?.id) resolve(data.job)
          else reject(new Error(data.error || 'Recording upload failed.'))
        }
        upload.onerror = () => reject(new Error('Recording upload failed. Check the LAN connection.'))
        upload.onabort = () => reject(new Error('Recording upload cancelled.'))
        upload.send(blob)
      })
      upload = null
      jobId = result.id
      const { auth } = await import('../firebase.js')
      rememberJob(result.id, activeOrg, auth.currentUser?.uid || '')
      setStatus(result.status === 'queued' ? 'Waiting in queue' : 'Recording received')
      pollJob(jobId, activeOrg)
    } catch (error) {
      upload = null
      if (!canceling) {
        setStatus(error?.message || 'Could not send recording to the Host.', 'error')
        retryButton.hidden = !lastRecording
      }
      cancelButton.hidden = true
    }
  }

  async function startRecording() {
    if (disabled || recording || jobId) return
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      setStatus('Microphone recording needs HTTPS and a supported browser.', 'error')
      return
    }
    savedPoint = saveInsertionPoint(field)
    review.hidden = true
    transcript.value = ''
    setStatus('Requesting microphone…')
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
      const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
        .find((type) => MediaRecorder.isTypeSupported?.(type))
      recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
      chunks = []
      recorder.ondataavailable = (event) => { if (event.data?.size) chunks.push(event.data) }
      recorder.onerror = () => {
        recorder.onstop = null
        stopTracks()
        resetCapture()
        setStatus('Microphone recording stopped unexpectedly.', 'error')
      }
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: recorder?.mimeType || mimeType || 'application/octet-stream' })
        chunks = []
        resetCapture()
        if (blob.size) { lastRecording = blob; void uploadRecording(blob) }
        else setStatus('No audio was recorded. Check the microphone and try again.', 'error')
      }
      recorder.start(1000)
      recording = true
      startedAt = Date.now()
      recordButton.disabled = false
      recordButton.classList.add('is-recording')
      recordButton.setAttribute('aria-label', 'Stop recording')
      recordLabel.textContent = 'Stop · 0:00'
      cancelButton.hidden = false
      setStatus('Recording…')
      elapsedTimer = setInterval(() => {
        const seconds = Math.min(300, Math.floor((Date.now() - startedAt) / 1000))
        recordLabel.textContent = 'Stop · ' + Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0')
        if (seconds >= 300) recorder?.stop()
      }, 500)
    } catch (error) {
      stopTracks()
      resetCapture()
      const message = error?.name === 'NotAllowedError'
        ? 'Microphone permission was denied.'
        : error?.name === 'NotFoundError'
          ? 'No microphone was found.'
          : 'Could not start microphone recording.'
      setStatus(message, 'error')
    }
  }

  function stopRecording() {
    if (recording && recorder?.state !== 'inactive') {
      setStatus('Preparing recording…')
      recorder.stop()
    }
  }

  async function cancelCurrent() {
    if (recording) {
      if (recorder?.state !== 'inactive') {
        recorder.onstop = null
        recorder.stop()
      }
      resetCapture()
      lastRecording = null
      retryButton.hidden = true
      setStatus('Recording cancelled.')
      return
    }
    canceling = true
    if (upload) { upload.abort(); upload = null }
    stopPolling()
    if (jobId) {
      try {
        const headers = await authHeaders()
        await fetch(window.location.origin + '/speech/jobs/' + encodeURIComponent(jobId) + '/cancel?orgId=' + encodeURIComponent(orgId), {
          method: 'POST', headers,
        })
      } catch {}
      jobId = ''
    }
    forgetJob()
    lastRecording = null
    retryButton.hidden = true
    cancelButton.hidden = true
    setStatus('Transcription cancelled.')
  }

  recordButton.disabled = disabled
  recordButton.onclick = () => recording ? stopRecording() : void startRecording()
  retryButton.onclick = () => { if (lastRecording) void uploadRecording(lastRecording) }
  cancelButton.onclick = () => void cancelCurrent()
  insertButton.onclick = () => { applyText(field, transcript.value, 'insert', savedPoint); review.hidden = true; forgetJob(); lastRecording = null; setStatus('Transcript inserted. Review and save the note when ready.', 'success') }
  appendButton.onclick = () => { applyText(field, transcript.value, 'append', savedPoint); review.hidden = true; forgetJob(); lastRecording = null; setStatus('Transcript appended. Review and save the note when ready.', 'success') }
  replaceButton.onclick = () => { applyText(field, transcript.value, 'replace', savedPoint); review.hidden = true; forgetJob(); lastRecording = null; setStatus('Field replaced. Review and save the note when ready.', 'success') }

  void (async () => {
    try {
      const { auth } = await import('../firebase.js')
      const uid = auth.currentUser?.uid || ''
      const activeOrg = String(getOrgId?.() || '')
      if (!uid || !activeOrg) return
      savedJobKey = 'medilogng.speechJob.' + uid + '.' + String(field.id || 'narrative')
      const saved = JSON.parse(localStorage.getItem(savedJobKey) || 'null')
      if (!saved || saved.uid !== uid || saved.orgId !== activeOrg || Date.now() - saved.createdAt > 35 * 60 * 1000) {
        if (saved) forgetJob()
        return
      }
      jobId = String(saved.id || '')
      orgId = activeOrg
      if (!jobId) { forgetJob(); return }
      setStatus('Reconnecting to transcription…')
      cancelButton.hidden = false
      pollJob(jobId, activeOrg)
    } catch { /* no saved job or local storage unavailable */ }
  })()

  return () => {
    destroyed = true
    stopPolling()
    if (upload) upload.abort()
    if (recording && recorder?.state !== 'inactive') recorder.stop()
    stopTracks()
    widget.remove()
  }
}
