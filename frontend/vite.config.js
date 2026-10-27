import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
const server = { host: '127.0.0.1', port: 5173, strictPort: true,
  proxy: { '/api': { target: 'http://127.0.0.1:5000', changeOrigin: false } } };
export default defineConfig({ plugins: [react()], server, preview: server,
  test: { environment: 'jsdom', setupFiles: './src/test/setup.js', restoreMocks: true } });
