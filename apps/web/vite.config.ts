import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    // In dev the backend runs separately; in production it serves this build
    // same-origin, so every request in the app is a bare `/api/...` path.
    proxy: { '/api': 'http://127.0.0.1:3008' },
  },
  build: {
    outDir: 'dist',
    // Capacitor loads the built app from the filesystem, where absolute asset
    // paths do not resolve. Relative ones work in both the WebView and the
    // same-origin web deployment.
    assetsDir: 'assets',
  },
  base: './',
});
