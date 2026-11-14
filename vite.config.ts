import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync } from 'node:fs';

const appVersion = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;

export default defineConfig({
  root: 'src/web',
  // Relative asset URLs let the same image run at / or behind a path prefix.
  base: './',
  plugins: [react(), tailwindcss()],
  define: { __APP_VERSION__: JSON.stringify(appVersion) },
  server: { proxy: { '/api/': 'http://localhost:3000' } },
  build: { outDir: '../../dist/web', emptyOutDir: true },
});
