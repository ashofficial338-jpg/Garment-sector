/** Starts the API and the React dev server together: `npm run dev` */
import { spawn } from 'child_process';

const run = (name, cwd, args) => {
  const p = spawn('npm', args, { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const tag = (d) => d.toString().split('\n').filter(Boolean).forEach((l) => console.log(`[${name}] ${l}`));
  p.stdout.on('data', tag);
  p.stderr.on('data', tag);
  p.on('exit', (code) => { console.log(`[${name}] exited (${code})`); process.exit(code ?? 1); });
  return p;
};

const procs = [run('api', 'server', ['run', 'dev']), run('web', 'client', ['run', 'dev'])];
const stop = () => { procs.forEach((p) => p.kill()); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
