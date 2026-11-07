from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[2]

def read(rel):
    return (ROOT / rel).read_text(encoding='utf-8')

def write(rel, text):
    (ROOT / rel).write_text(text, encoding='utf-8')

def remove_regex(rel, pattern, flags=re.S):
    text = read(rel)
    new, n = re.subn(pattern, '', text, flags=flags)
    if n == 0:
        raise RuntimeError(f'pattern did not match {rel}: {pattern[:100]}')
    write(rel, new)

# Remove the client microphone/recording UI and all styles for it.
for rel in ['src/components/speechInput.js', 'src/services/pendingSpeech.js', 'src/services/speechTransport.js']:
    (ROOT / rel).unlink(missing_ok=True)
css = read('src/app.css')
css, n = re.subn(r'\.soap-note-field \.speech-control.*?@media \(prefers-reduced-motion: reduce\) \{ \.speech-record\.is-recording > span:first-child \{ animation: none; \} \}\n', '', css, flags=re.S)
if n != 1: raise RuntimeError('speech SOAP CSS block not removed')
css, n = re.subn(r'\.enc-plan-speech-slot.*?\.enc-plan-speech-slot \.speech-transcribe, \.enc-plan-speech-slot \.speech-pending-select \{.*?\}\n', '', css, flags=re.S)
if n != 1: raise RuntimeError('speech plan CSS block not removed')
write('src/app.css', css)

# Remove UI mounting while preserving the text-only clinical AI panel.
rel = 'src/views/ConsultationsView.js'
t = read(rel)
t = t.replace("import { attachSpeechInput } from '../components/speechInput.js'\n", '')
t = t.replace('  const speechCleanups = []\n', '')
t = t.replace("          '<span id=\"planSpeechSlot\" class=\"enc-plan-speech-slot\" aria-label=\"Dictate treatment plan\"></span>' +\n", '')
t = re.sub(r"  const passTranscriptToClinicalAi = \(text\) => \{.*?\n  if \(caps\.canEdit\) \{\n    SOAP_FIELDS\.forEach\(\(\{ key \}\) => \{.*?\n    \}\n  \}\n", '', t, flags=re.S)
t = t.replace('    speechCleanups.forEach((cleanup) => cleanup())\n', '')
write(rel, t)

# Keep offline Host authentication, but remove the voice-to-text naming from its neutral device-session plumbing.
old = ROOT / 'src/services/speechSession.js'
new = ROOT / 'src/services/deviceSession.js'
if old.exists():
    text = old.read_text(encoding='utf-8')
    text = text.replace('medlogng-speech-session', 'medlogng-device-session')
    text = text.replace('Speech', 'Device').replace('speech', 'device')
    text = text.replace('x-device-', 'x-device-')
    old.unlink()
    new.write_text(text, encoding='utf-8')

# Replace imports and neutral session identifiers throughout first-party code.
paths = [
    'src/services/authService.js', 'src/services/clinicalOutbox.js',
    'src/services/hostQueryRead.js', 'src/services/hostSeed.js', 'src/services/hostSession.js',
    'hub/server.js', 'electron/host.js'
]
for rel in paths:
    p = ROOT / rel
    text = p.read_text(encoding='utf-8')
    text = text.replace('speechSession.js', 'deviceSession.js')
    text = text.replace('SpeechSessions', 'DeviceSessions').replace('speechSessions', 'deviceSessions')
    text = text.replace('SpeechSession', 'DeviceSession').replace('speechSession', 'deviceSession')
    text = text.replace('auditSpeech', 'auditDevice')
    text = text.replace('x-speech-', 'x-device-')
    p.write_text(text, encoding='utf-8')

# Remove auth lifecycle calls that existed only for the old voice subsystem; neutral device auth is request-scoped.
rel = 'src/services/authService.js'
t = read(rel)
t = re.sub(r"  if \(user\?\.uid\) \{\n    const \{ clearAllDeviceSessions \} = await import\('./deviceSession\.js'\)\n    await clearAllDeviceSessions\(user\.uid\)\n  \n", '', t)
t = re.sub(r"  const revalidateCachedDevice = async \(\) => \{.*?\n  window\.addEventListener\('online', \(\) => \{ void revalidateCachedDevice\(\) \}\)\n  window\.addEventListener\('focus', \(\) => \{ void revalidateCachedDevice\(\) \}\)\n", '', t, flags=re.S)
t = t.replace('    if (u) void revalidateCachedDevice()\n', '')
write(rel, t)

# Remove cloud transcription handlers and Deepgram configuration from Firebase Functions.
rel = 'functions/index.js'
t = read(rel)
t = t.replace("import { createHash } from 'node:crypto'\n", '')
t = t.replace("import { checkDeepgram, transcribeWithDeepgram } from './speechProvider.js'\n", '')
t = t.replace("const DEEPGRAM_API_KEY = defineSecret('DEEPGRAM_API_KEY')\n", '')
t = re.sub(r'export function createSpeechHttpHandler\(.*?\n\}\n\nexport function createSpeechHealthHandler\(.*?\n\}\n\n', '', t, flags=re.S)
t = re.sub(r'const speechHandler = createSpeechHttpHandler\(.*?\nexport const speechHealth = .*?\n', '', t, flags=re.S)
write(rel, t)

# Remove Host transcription handler, health route, and old speech session retirement routes. Device-session routes remain for offline data auth.
rel = 'hub/server.js'
t = read(rel)
t = t.replace("import { checkDeepgram, transcribeWithDeepgram } from '../functions/speechProvider.js'\n", '')
t = t.replace("// and speech job service; HTTP compatibility is retained.\n", '')
t = t.replace("// HTTPS port for secure-context features such as browser microphone access.\n", "// HTTPS is used for authenticated Host operations.\n")
t = t.replace(", x-device-request-id, x-device-device, x-device-timestamp, x-device-nonce, x-device-signature, x-device-body-sha256", '')
t = re.sub(r",?\s*speechProvider = transcribeWithDeepgram", '', t)
t = re.sub(r"  let activeSpeechRequests = 0\n", '', t)
t = re.sub(r"  async function handleSpeechTranscribe\(req, res, url\) \{.*?\n  \}\n", '', t, flags=re.S)
t = re.sub(r"    if \(req\.method === 'GET' && path === '/speech/health'\) \{.*?\n    \}\n\n", '', t, flags=re.S)
t = re.sub(r"\n    if \(req\.method === 'POST' && path === '/speech/transcribe'\) \{.*?\n    \}\n    if \(path === '/speech/jobs'.*?\n    \}\n", '\n', t, flags=re.S)
t = re.sub(r"\n    speech: \{ enabled: process\.env\.DEEPGRAM_ALLOW_CLINICAL_AUDIO === 'true' && !!process\.env\.DEEPGRAM_API_KEY && !!process\.env\.DEEPGRAM_ENDPOINT \},", '', t)
t = re.sub(r"\n  async function offlineDeviceSessionRoute\(req, res, url, action\) \{.*?\n  \}\n", lambda m: m.group(0), t, flags=re.S)  # retained under neutral name after replacements
# Remove initialization and handler-only injection of the deleted audit/provider features.
t = re.sub(r"\n  let deviceSessions = null\n  if \(typeof overrides\.loadDeviceSessions === 'function' && typeof overrides\.saveDeviceSessions === 'function'\) \{.*?\n  \}\n", '\n', t, flags=re.S)
t = t.replace('    clinicalAi,\n    auditDevice: overrides.auditDevice,\n    speechProvider: overrides.speechProvider || transcribeWithDeepgram,\n    verifiedHttpsAddresses,', '    clinicalAi,\n    verifiedHttpsAddresses,')
write(rel, t)

# Remove Electron persistence for voice-session/audit state; offline device-session state is no longer persisted here.
rel = 'electron/host.js'
t = read(rel)
t = re.sub(r"\n    loadDeviceSessions: async \(\) => \{.*?\n    \},\n    saveDeviceSessions: async \(json\) => \{.*?\n    \},\n    auditDevice: async \(record\) => \{.*?\n    \},", '', t, flags=re.S)
write(rel, t)

# Build/package/test/docs cleanup.
rel = 'package.json'; t = read(rel)
t = re.sub(r",?\s*&& npm run test:speech", '', t)
t = re.sub(r'\n\s*"test:speech":.*?\n\s*"test:speech:listeners":.*?(?=\n\s*"hub")', '', t, flags=re.S)
write(rel, t)
rel = 'functions/package.json'; t = read(rel)
t = t.replace(' && node ../scripts/test/speech.functions.test.mjs', '')
write(rel, t)
rel = 'electron-builder.host.yml'; t = read(rel)
t = re.sub(r"\n\s*- functions/speechProvider\.js", '', t)
write(rel, t)
rel = 'build-host.bat'; t = read(rel)
t = re.sub(r"\r?\n.*Deepgram.*", '', t, flags=re.I)
t = re.sub(r"\r?\n.*transcription.*", '', t, flags=re.I)
write(rel, t)

# Delete dedicated source/docs/tests and known generated voice artifacts.
for rel in [
    'functions/speechProvider.js',
    'hub/speech',
    'scripts/test/create-speech-test-certificate.ps1',
    'scripts/test/speech.functions.test.mjs',
    'scripts/test/speech.listeners.test.mjs',
    'scripts/test/speech.provider.test.mjs',
    'scripts/test/speech.sessions.test.mjs',
    'scripts/test/speech.transport.test.mjs',
    '.cache/DeepgramLiveTest',
    '.tmp-speech-test-KjDmmj',
    '.tmp-speech-assets-test-0nB0mj',
    '.tmp-speech-assets-test-kTnp4f',
    '.tmp-speech-listeners-2dq2lK',
    '.tmp-speech-listeners-9GH6Aq',
]:
    p = ROOT / rel
    if p.is_dir():
        import shutil; shutil.rmtree(p)
    else:
        p.unlink(missing_ok=True)

# Remove stale built installers/assets so old bundled code is not left in the workspace; build will regenerate dist.
for rel in ['dist', 'release']:
    p = ROOT / rel
    if p.exists():
        import shutil; shutil.rmtree(p)
