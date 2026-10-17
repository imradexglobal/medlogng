// Run a command with a hard timeout so a wedged build/deploy fails loudly
// instead of hanging forever. On timeout the whole process tree is killed
// (taskkill /T), because npm/vite spawn grandchildren that would otherwise
// survive and hold cache locks for the next run.
//
// Usage: node scripts/run-with-timeout.mjs <seconds> <command> [args...]
//   e.g. node scripts/run-with-timeout.mjs 300 npm run build
// Exit codes: child's own exit code, or 124 on timeout, 2 on bad usage.
import { spawn } from 'node:child_process';

const [secondsArg, ...cmdParts] = process.argv.slice(2);
const seconds = Number(secondsArg);
if (!Number.isFinite(seconds) || seconds <= 0 || !cmdParts.length) {
  console.error('Usage: node scripts/run-with-timeout.mjs <seconds> <command> [args...]');
  process.exit(2);
}

const command = cmdParts.join(' ');
const child = spawn(command, { shell: true, stdio: 'inherit', windowsHide: true });

let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  console.error('\n[timeout] "' + command + '" exceeded ' + seconds + 's - killing process tree.');
  try {
    spawn('taskkill', ['/PID', String(child.pid), '/F', '/T'], { stdio: 'ignore', windowsHide: true });
  } catch { /* taskkill missing or already gone */ }
}, seconds * 1000);

child.on('error', (err) => {
  clearTimeout(timer);
  console.error('[timeout] failed to start "' + command + '": ' + err.message);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  clearTimeout(timer);
  if (timedOut) process.exit(124);
  process.exit(signal ? 1 : (code ?? 1));
});
