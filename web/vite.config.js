import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev server proxies API + WebSocket calls to the Go api on :8080 so the
// frontend can be hot-reloaded against a live backend.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        ws: true,
      },
    },
  },
})
