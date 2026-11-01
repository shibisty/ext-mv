import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['e2e/**/*.e2e.ts'], environment: 'node', testTimeout: 60000, hookTimeout: 60000, fileParallelism: false },
});
