// Сборка страниц расширения. Библиотека gmv берётся из исходников (packages/gmv/src) — отдельная сборка библиотеки не нужна.
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const lib = resolve(__dirname, '../../packages/gmv/src');

export default defineConfig(({ mode }) => ({
  root: __dirname,
  base: './',
  publicDir: 'public',
  resolve: {
    alias: [
      { find: /^gmv\/engines$/, replacement: resolve(lib, 'engines/index.ts') },
      { find: /^gmv\/engines\/(.+)$/, replacement: resolve(lib, 'engines/$1/index.ts') },
      { find: /^gmv\/renderer$/, replacement: resolve(lib, 'renderer/index.ts') },
      { find: /^gmv$/, replacement: resolve(lib, 'index.ts') },
    ],
  },
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
