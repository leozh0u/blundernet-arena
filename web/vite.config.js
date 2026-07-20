import { writeFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// dist/.gitkeep is tracked so go:embed finds the directory on a fresh
// clone; vite wipes dist on every build, so restore it afterwards.
const keepDist = {
  name: 'keep-gitkeep',
  closeBundle() {
    writeFileSync('dist/.gitkeep', '')
  },
}

// Dev server proxies API + WebSocket calls to the Go api on :8080 so the
// frontend can be hot-reloaded against a live backend.
export default defineConfig({
  plugins: [react(), keepDist],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        ws: true,
      },
    },
  },
})
