import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./test/helpers/env.js'],
    include: ['test/**/*.test.js'],
    testTimeout: 10000,
  },
});
