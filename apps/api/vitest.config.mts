import { defineConfig } from 'vitest/config';

// Specs sit next to the code they test (`*.spec.ts`), as in the rest of the
// company's services. Decorated classes need reflect-metadata loaded first.
export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts', 'config/**/*.spec.ts'],
    setupFiles: ['./test/setup.ts'],
    environment: 'node',
  },
});
