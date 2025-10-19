// vite.config.ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',      // allow LAN access
    port: 5174,           // match the port you're running with
    strictPort: true,     // fail fast if the port is taken
    watch: {
      // more reliable on Docker/WSL/NFS or remote folders
      usePolling: true,
      interval: 100
    },    
    proxy: {
      '/auth': 'http://localhost:8000',
      '/config': 'http://localhost:8000',
      '/models': 'http://localhost:8000',
      '/sessions': 'http://localhost:8000',
      '/traces': 'http://localhost:8000',
      '/uploads': 'http://localhost:8000',
      '/rag': 'http://localhost:8000'
      // If your backend needs the Host header rewritten (common in Docker), do:
      // '/auth': { target: 'http://localhost:8000', changeOrigin: true }
    }
  }
})
