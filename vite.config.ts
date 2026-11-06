import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  root: 'src/web',
  // Relative asset URLs let the same image run at / or behind a path prefix.
  base: './',
  plugins: [react(), tailwindcss()],
  server: { proxy: { '/api': 'http://localhost:3000' } },
  build: { outDir: '../../dist/web', emptyOutDir: true },
});
