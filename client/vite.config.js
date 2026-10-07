import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

/**
 * The UI always calls /api on its own origin; this proxy decides which backend answers:
 *   npm run dev          → local API (http://localhost:5050)
 *   npm run dev:remote   → deployed Render API (client/.env.remote)
 *   API_TARGET=<url>     → any other backend
 * In production, vercel.json does the same forwarding to Render.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, '');
  const target = process.env.API_TARGET || env.API_TARGET || 'http://localhost:5050';
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
          // Render free instances can take ~50 s to wake up
          proxyTimeout: 120000,
          timeout: 120000,
          configure: (proxy) => {
            proxy.on('error', (_err, _req, res) => {
              if (res.headersSent) return;
              res.writeHead(503, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                message: remote
                  ? `Cannot reach the backend at ${target}. It may be waking up (free plan) – try again in a minute.`
                  : 'API server is not running on port 5050. Start it with "npm run dev" (or "npm run dev:server").',
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
