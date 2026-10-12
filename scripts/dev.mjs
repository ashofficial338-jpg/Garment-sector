/**
 * Starts the API and the React dev server together: `npm run dev`
 *
 * Each side runs its own package.json "dev" script through npm – started as `node <npm-cli.js> run dev`, i.e. a
 * direct process launch with an argument array and NO shell (npm is a .cmd file on Windows, which is why a shell
 * was needed before; `shell: true` with arguments is deprecated – DEP0190 – because they are not escaped).
 * When either side stops, or on Ctrl+C, the other side's whole process tree is stopped too, so no orphaned
 * server keeps holding port 5050 / 5173.
 */
import { spawn, spawnSync } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** npm's JavaScript entry: the one running this script, else the copy installed next to node. */
function npmCli() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'), // Windows layout
    path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), // POSIX layout
  ];
  const found = candidates.find((p) => p && /npm-cli\.js$/.test(p) && existsSync(p));
  if (!found) throw new Error('Cannot locate npm-cli.js – start the API and UI separately with "npm run dev:server" and "npm run dev:client"');
  return found;
}

/** Stop a child and everything it started (npm → shell → node / vite). */
function stopTree(p) {
  if (!p.pid || p.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore' });
  else { try { process.kill(-p.pid, 'SIGTERM'); } catch { p.kill('SIGTERM'); } }
}

const NPM = npmCli();
const procs = [];
let stopping = false;
function stopAll(code) {
  if (stopping) return;
  stopping = true;
  procs.forEach(stopTree);
  process.exit(code);
}

function run(name, dir) {
  const p = spawn(process.execPath, [NPM, 'run', 'dev'], {
    cwd: path.join(root, dir), stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32', // own process group on POSIX so the whole tree can be stopped
  });
  const tag = (d) => d.toString().split(/\r?\n/).filter(Boolean).forEach((l) => console.log(`[${name}] ${l}`));
  p.stdout.on('data', tag);
  p.stderr.on('data', tag);
  p.on('error', (e) => { console.error(`[${name}] failed to start: ${e.message}`); stopAll(1); });
  p.on('exit', (code) => {
    if (stopping) return;
    console.log(`[${name}] exited (${code}) – stopping the other server`);
    stopAll(code ?? 1);
  });
  procs.push(p);
}

run('api', 'server');
run('web', 'client');
process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));
