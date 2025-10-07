import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/auth': 'http://localhost:8000',
      '/config': 'http://localhost:8000',
      '/models': 'http://localhost:8000',
      '/sessions': 'http://localhost:8000',
      '/traces': 'http://localhost:8000',
      '/uploads': 'http://localhost:8000'
    }
  }
});
