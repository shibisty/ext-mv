import { defineConfig, mergeConfig } from 'vitest/config';
import base from '../../../vite.config';

export default mergeConfig(base, defineConfig({
  test: { include: ['e2e/**/*.e2e.ts'], environment: 'node', testTimeout: 60000, hookTimeout: 60000, fileParallelism: false },
}));
