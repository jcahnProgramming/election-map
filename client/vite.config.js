import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// API_TARGET lets a second dev server point at another backend (e.g. a local mock); default is the dev API.
const API = process.env.API_TARGET || 'http://localhost:3710';
const SOCKET = process.env.SOCKET_TARGET || API;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: API, changeOrigin: true },
      '/socket.io': { target: SOCKET, changeOrigin: true, ws: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1000 },
});
