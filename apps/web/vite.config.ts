import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@friendzone/shared': new URL('../../packages/shared/src/index.ts', import.meta.url).pathname,
    },
  },
  server: {
    port: 5174,
    // The API and the WebSocket are proxied in development so the browser sees
    // one origin. It keeps dev honest about cookies and CORS, and means the
    // client never needs a base URL.
    proxy: {
      '/api': { target: 'http://localhost:8080', changeOrigin: true },
      '/ws': { target: 'ws://localhost:8080', ws: true },
      '/health': 'http://localhost:8080',
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
})
