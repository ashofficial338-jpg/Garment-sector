import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import net from 'net';
import https from 'https';

/**
 * The UI always calls /api on its own origin; this proxy decides which backend answers:
 *   API_TARGET=<url>         → that backend, always
 *   npm run dev:remote       → deployed Render API (client/.env.remote)
 *   npm run dev (default)    → the local API on :5050 whenever it is running, otherwise the deployed Render API.
 *                              Decided per request (re-checked every 2 s), so starting or stopping the local API
 *                              takes effect without restarting the UI. The deployed API may run older code than
 *                              this checkout – new endpoints then answer 404 until it is redeployed.
 * In production, vercel.json does the same forwarding to Render.
 */
const LOCAL = 'http://localhost:5050';
const REMOTE_PREFIX = '/__api_remote';

const localApiRunning = () => new Promise((resolve) => {
  const s = net.connect({ host: '127.0.0.1', port: 5050 });
  const done = (ok) => { s.destroy(); resolve(ok); };
  s.setTimeout(600, () => done(false));
  s.once('connect', () => done(true));
  s.once('error', () => done(false));
});

/** Cached "is the local API up?" – at most one TCP probe every 2 s. */
function localProbe() {
  let last = 0; let up = false; let pending = null;
  return async () => {
    if (Date.now() - last < 2000) return up;
    pending ||= localApiRunning().then((ok) => { up = ok; last = Date.now(); pending = null; return ok; });
    return pending;
  };
}

/** Sends /api to the local API when it is running, else re-routes the request to the remote proxy entry. */
function apiRouter(remoteUrl) {
  const isUp = localProbe();
  let current = null;
  return {
    name: 'api-router',
    configureServer(server) {
      // registered before Vite's internal middlewares, so it runs ahead of the proxy
      server.middlewares.use(async (req, _res, next) => {
        if (!req.url?.startsWith('/api')) return next();
        const local = await isUp();
        const target = local ? LOCAL : remoteUrl;
        if (target !== current) {
          current = target;
          // eslint-disable-next-line no-console
          console.log(`  [api] → ${target}${local ? ' (local server)' : ' (deployed backend – no local API on :5050)'}`);
        }
        if (!local) req.url = REMOTE_PREFIX + req.url;
        next();
      });
    },
  };
}

const proxyEntry = (target, extra = {}) => {
  const remote = !/localhost|127\.0\.0\.1/.test(target);
  return {
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
            : 'API server is not running on port 5050. Start it with "npm run dev" from the project folder.',
        }));
      });
    },
    ...extra,
  };
};

export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, __dirname, '');
  const remoteUrl = loadEnv('remote', __dirname, '').API_TARGET;
  const fixed = process.env.API_TARGET || env.API_TARGET;
  // per-request choice only when no backend is pinned and a deployed one exists to fall back to
  const dynamic = command === 'serve' && !fixed && !!remoteUrl;
  const target = fixed || LOCAL;
  if (command === 'serve' && !dynamic) {
    // eslint-disable-next-line no-console
    console.log(`\n  API → ${target}${target === LOCAL ? ' (local server)' : ' (fixed by API_TARGET)'}\n`);
  }

  return {
    plugins: [react(), ...(dynamic ? [apiRouter(remoteUrl)] : [])],
    resolve: { alias: { '@shared': path.resolve(__dirname, '../shared') } },
    server: {
      port: 5173,
      fs: { allow: ['..'] },
      proxy: {
        '/api': proxyEntry(target),
        ...(dynamic ? { [REMOTE_PREFIX]: proxyEntry(remoteUrl, { rewrite: (p) => p.slice(REMOTE_PREFIX.length) }) } : {}),
      },
    },
    build: {
      chunkSizeWarningLimit: 1500,
      rollupOptions: { output: { manualChunks: { charts: ['recharts'], pdf: ['jspdf', 'jspdf-autotable'] } } },
    },
  };
});
