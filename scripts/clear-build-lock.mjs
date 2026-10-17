// Kill stale Node processes that can deadlock `vite build` on Windows, then
// verify the dev port is free.
//
// Why this exists: a previous stuck `firebase deploy` or `vite` run leaves
// node.exe processes behind that hold npm/Vite cache locks. The next build
// then hangs forever right after "> vite build" with no output.
//
// Kill rules:
//   1. Any node.exe whose command line references THIS project root
//      (leftover dev server, hub, electron, half-finished builds).
//   2. Orphaned `firebase deploy` / `firebase --version` processes (these
//      are the classic stuck leftovers and often carry no project path).
// If port 5174 is still held afterwards, fail with the holder's identity.
//
// Usage: node scripts/clear-build-lock.mjs
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const PORT = 5174;

const ps = [
  "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ForEach-Object {",
  "  $cl = $_.CommandLine; if ($null -eq $cl) { $cl = '' };",
  "  Write-Output ($_.ProcessId.ToString() + [char]9 + $cl)",
  "}",
].join('\n');

let out = '';
try {
  out = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps],
    { encoding: 'utf8', windowsHide: true });
} catch (err) {
  console.error('[clear-lock] WARNING: could not list processes: ' + err.message);
  process.exit(0); // non-fatal - the build may still be fine
}

const procs = out.split(/\r?\n/)
  .map((l) => l.trim())
  .filter(Boolean)
  .map((l) => {
    const i = l.indexOf('\t');
    if (i < 0) return null;
    return { pid: Number(l.slice(0, i)), cmd: l.slice(i + 1) };
  })
  .filter((p) => p && Number.isFinite(p.pid));

const rootNorm = root.toLowerCase().replace(/\//g, '\\');

function isStale(p) {
  if (p.pid === process.pid || p.pid === process.ppid) return false;
  const cmd = p.cmd.toLowerCase().replace(/\//g, '\\');
  if (!cmd) return false;
  if (cmd.includes(rootNorm)) return true; // anything belonging to this project
  if (/firebase\.js\s+deploy\b/.test(cmd)) return true; // stuck deploy
  if (/firebase\.js\s+--version\b/.test(cmd)) return true; // orphaned version probe
  if (cmd.includes('firebase deploy')) return true; // deploy via npm/npx shim
  return false;
}

const stale = procs.filter(isStale);
for (const p of stale) {
  const short = p.cmd.length > 110 ? p.cmd.slice(0, 110) + '...' : p.cmd;
  console.log('[clear-lock] killing PID ' + p.pid + ': ' + short);
  try {
    execFileSync('taskkill', ['/PID', String(p.pid), '/F', '/T'],
      { stdio: 'ignore', windowsHide: true });
  } catch (err) {
    console.error('[clear-lock] WARNING: could not kill PID ' + p.pid + ': ' + err.message);
  }
}
if (!stale.length) console.log('[clear-lock] no stale build/dev processes found.');

function portFree() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(PORT, '127.0.0.1');
  });
}

for (let i = 0; i < 20; i++) { // up to ~10s for killed processes to release the port
  if (await portFree()) {
    console.log('[clear-lock] port ' + PORT + ' is free.');
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 500));
}

// Something else (not ours, or not killable) still holds the port - say what.
const holder = procs.find((p) => {
  const cmd = p.cmd.toLowerCase();
  return cmd.includes(':' + PORT) || cmd.includes('port ' + PORT) || cmd.includes('--port ' + PORT);
});
console.error('[clear-lock] ERROR: port ' + PORT + ' is still in use.' +
  (holder ? ' Holder: PID ' + holder.pid + ' ' + holder.cmd : ''));
process.exit(1);
