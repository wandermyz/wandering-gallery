import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig({
  root: 'src/client',
  plugins: [preact()],
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
    target: ['es2022', 'safari16'],
  },
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://127.0.0.1:2334', changeOrigin: false } },
  },
});
