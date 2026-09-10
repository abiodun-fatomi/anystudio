import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Pure contracts run in Node; component regression suites opt into jsdom.
// Transform JSX here without changing Next's required jsx:preserve tsconfig.
export default defineConfig({
  oxc: { jsx: { runtime: 'automatic' } },
  resolve: { alias: { '@': fileURLToPath(new URL('./', import.meta.url)) } },
  test: { include: ['lib/**/*.spec.{ts,tsx}', 'app/**/*.spec.{ts,tsx}', 'components/**/*.spec.{ts,tsx}'], environment: 'node' },
});
