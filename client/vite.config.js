import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@shared': path.resolve(__dirname, '../shared') } },
  server: {
    port: 5173,
    fs: { allow: ['..'] },
    proxy: {
      '/api': {
        target: 'http://localhost:5050',
        changeOrigin: true,
        // Clear message instead of a bare 500 when the API server is not running
        configure: (proxy) => proxy.on('error', (_err, _req, res) => {
          if (res.headersSent) return;
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: 'API server is not running on port 5050. Start it with "npm run dev" (or "npm run dev:server").' }));
        }),
      },
    },
  },
  build: {
    chunkSizeWarningLimit: 1500,
    rollupOptions: { output: { manualChunks: { charts: ['recharts'], pdf: ['jspdf', 'jspdf-autotable'] } } },
  },
});
