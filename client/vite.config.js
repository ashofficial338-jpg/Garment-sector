import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import net from 'net';
import https from 'https';

/**
 * The UI always calls /api on its own origin; this proxy decides which backend answers:
 *   API_TARGET=<url>         → that backend
 *   npm run dev:remote       → deployed Render API (client/.env.remote)
 *   npm run dev (default)    → local API on :5050 if it is running, otherwise the deployed Render API
 * In production, vercel.json does the same forwarding to Render.
 */
const LOCAL = 'http://localhost:5050';

const localApiRunning = () => new Promise((resolve) => {
  const s = net.connect({ host: '127.0.0.1', port: 5050 });
  const done = (ok) => { s.destroy(); resolve(ok); };
  s.setTimeout(600, () => done(false));
  s.once('connect', () => done(true));
  s.once('error', () => done(false));
});

export default defineConfig(async ({ mode, command }) => {
  const env = loadEnv(mode, __dirname, '');
  const remoteUrl = loadEnv('remote', __dirname, '').API_TARGET;
  let target = process.env.API_TARGET || env.API_TARGET;
  if (!target && command === 'serve') {
    target = (await localApiRunning()) || !remoteUrl ? LOCAL : remoteUrl;
    // eslint-disable-next-line no-console
    console.log(`\n  API → ${target}${target === LOCAL ? ' (local server)' : ' (deployed backend – no local API on :5050)'}\n`);
  }
  target ||= LOCAL;
  const remote = !/localhost|127\.0\.0\.1/.test(target);

  return {
    plugins: [react()],
    resolve: { alias: { '@shared': path.resolve(__dirname, '../shared') } },
    server: {
      port: 5173,
      fs: { allow: ['..'] },
      proxy: {
        '/api': {
          target,
          changeOrigin: true,
          secure: true,
          // Reuse TLS connections to the remote backend instead of a new handshake per request
          ...(remote && target.startsWith('https') ? { agent: new https.Agent({ keepAlive: true, maxSockets: 16 }) } : {}),
          // Render free instances can take ~50 s to wake up
          proxyTimeout: 120000,
          timeout: 120000,
          configure: (proxy) => {
            proxy.on('error', (err, req, res) => {
              // eslint-disable-next-line no-console
              console.warn(`  [api] ${req.method} ${req.url} → ${err.code || err.message}`);
              if (!res || res.headersSent) return;
              res.writeHead(503, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                message: remote
                  ? `Cannot reach the backend at ${target}. It may be waking up (free plan) – try again in a minute.`
                  : 'API server is not running on port 5050. Start it with "npm run dev" from the project folder, or restart the UI to use the deployed backend.',
              }));
            });
          },
        },
      },
    },
    build: {
      chunkSizeWarningLimit: 1500,
      rollupOptions: { output: { manualChunks: { charts: ['recharts'], pdf: ['jspdf', 'jspdf-autotable'] } } },
    },
  };
});
