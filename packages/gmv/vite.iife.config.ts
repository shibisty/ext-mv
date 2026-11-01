// Сборка «всё в одном» для <script>: dist/gmv.iife.js с глобальным объектом GMV.
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    target: 'es2022',
    sourcemap: true,
    lib: {
      entry: resolve(__dirname, 'src/standalone.ts'),
      name: 'GMV',
      formats: ['iife'],
      fileName: () => 'gmv.iife.js',
    },
  },
});
