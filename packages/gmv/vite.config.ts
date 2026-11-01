// Сборка библиотеки: ES-модули с сохранением структуры (точки входа — ядро, каждый движок, рендерер).
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const src = resolve(__dirname, 'src');
const engines = readdirSync(resolve(src, 'engines'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
    minify: false,
    lib: {
      formats: ['es'],
      entry: {
        index: resolve(src, 'index.ts'),
        'engines/index': resolve(src, 'engines/index.ts'),
        'renderer/index': resolve(src, 'renderer/index.ts'),
        ...Object.fromEntries(engines.map((e) => [`engines/${e}/index`, resolve(src, `engines/${e}/index.ts`)])),
      },
    },
    rollupOptions: {
      output: { preserveModules: true, preserveModulesRoot: 'src', entryFileNames: '[name].js' },
    },
  },
});
