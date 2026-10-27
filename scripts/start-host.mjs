import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.MEDILOG_HOST = '1';

const electronPkg = await import('electron');
const electronPath = electronPkg.default || electronPkg;

console.log('[host-dev] Launching Electron in Host Mode...');
const child = spawn(electronPath, ['.'], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    MEDILOG_HOST: '1',
  },
});

child.on('close', (code) => {
  process.exit(code || 0);
});
