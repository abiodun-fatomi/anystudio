import { defineConfig } from 'vitest/config';

// Specs sit next to the code they test (`*.spec.ts`), as in the rest of the
// company's services. Decorated classes need reflect-metadata loaded first.
export default defineConfig({
  test: {
    // The seeded catalogues live in @anystudio/db, which has no runner of its
    // own, and their CONTENT is load-bearing: a template with a broken
    // category lands in the wrong chip and a scene with no prompt renders
    // nothing, neither of which a typecheck can see. Rather than add a second
    // test project and a second CI step for one file, the API — the service
    // that reads those rows — runs their specs too.
    include: ['src/**/*.spec.ts', 'config/**/*.spec.ts', '../../packages/db/prisma/**/*.spec.ts'],
    setupFiles: ['./test/setup.ts'],
    environment: 'node',
  },
});
