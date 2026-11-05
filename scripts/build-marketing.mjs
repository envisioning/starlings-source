import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
execFileSync('pnpm', ['--filter', '@starlings/web', 'exec', 'vite', 'build', '--config', 'marketing/vite.config.ts'], { cwd: root, stdio: 'inherit' });
execFileSync('pnpm', ['--filter', '@starlings/web', 'exec', 'node', 'marketing/prerender.mjs'], { cwd: root, stdio: 'inherit' });
