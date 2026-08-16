import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * The board interface.
 *
 * Built to `dist/web` and served by the Fastify process, so `gorilla serve`
 * remains one command and one port. The dev server proxies the API rather than
 * duplicating it.
 */
export default defineConfig({
  root: 'src/web',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
  },
  server: {
    port: 4301,
    proxy: {
      '/api': 'http://127.0.0.1:4300',
      '/stream': { target: 'http://127.0.0.1:4300', ws: false },
    },
  },
});
