import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

// The bundle's own version (CHANGELOG.json is the single source): the app compares it with /api/health to offer a reload.
const APP_VERSION = JSON.parse(readFileSync(new URL('../CHANGELOG.json', import.meta.url), 'utf8')).releases?.[0]?.version ?? null;

// API_TARGET lets a second dev server point at another backend (e.g. a local mock); default is the dev API.
const API = process.env.API_TARGET || 'http://localhost:3710';
const SOCKET = process.env.SOCKET_TARGET || API;

export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(APP_VERSION) },
  server: {
    port: 5173,
    // Dev-only pages under client/dev/ (photo review) read the candidate photo files and the shared photo rules.
    // Nothing else outside client/ is served; never the SQLite data directory.
    fs: { allow: ['.', '../config/elections', '../config/elections.json', '../server/src/photo-rules.js'] },
    proxy: {
      '/api': { target: API, changeOrigin: true },
      '/photos': { target: API, changeOrigin: true },
      '/socket.io': { target: SOCKET, changeOrigin: true, ws: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1000 },
});
