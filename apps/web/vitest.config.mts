import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// The web app's tests are not about React. They are about the contract
// between the studio's tool definitions and the capability schemas in
// @anystudio/shared — the seam where a field can be collected from a
// customer and then silently thrown away.
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./', import.meta.url)) } },
  test: { include: ['lib/**/*.spec.ts', 'app/**/*.spec.ts'], environment: 'node' },
});
