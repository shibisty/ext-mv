import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vite.config';

export default mergeConfig(base, defineConfig({
  test: {
    include: ['apps/*/test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30000,
  },
}));
