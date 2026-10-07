// The Electron main process and the release scripts. The designer page's own
// tests (designer/static/*.test.mjs) use node:test; run them with
// `npm run test:designer`.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['electron/**/*.spec.ts', 'build_tools/**/*.spec.ts'],
    environment: 'node',
  },
});
