// Сборка страниц расширения. Пакеты @gmvjs/* — из npm.
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => ({
  root: __dirname,
  base: './',
  publicDir: 'public',
  build: {
    outDir: process.env.GMV_OUT_DIR ?? 'dist/.build',
    emptyOutDir: true,
    target: ['chrome116', 'firefox115'],
    sourcemap: mode === 'development',
    minify: mode !== 'development',
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: { viewer: resolve(__dirname, 'viewer.html'), background: resolve(__dirname, 'src/background.ts') },
      output: {
        entryFileNames: (c) => (c.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js'),
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
}));
