import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Where the API lives in development. Overridable so a run can move off 8080
// when something else on the machine already has it.
const API_PORT = process.env['E2E_API_PORT'] ?? process.env['API_PORT'] ?? '8080'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@friendzone/shared': new URL('../../packages/shared/src/index.ts', import.meta.url).pathname,
    },
  },
  server: {
    port: Number(process.env['E2E_WEB_PORT'] ?? 5174),
    // The API and the WebSocket are proxied in development so the browser sees
    // one origin. It keeps dev honest about cookies and CORS, and means the
    // client never needs a base URL.
    proxy: {
      '/api': { target: `http://localhost:${API_PORT}`, changeOrigin: true },
      '/ws': { target: `ws://localhost:${API_PORT}`, ws: true },
      '/health': `http://localhost:${API_PORT}`,
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
})
