/**
 * The API has to find the repo's one `.env` from wherever it was started.
 *
 * `pnpm dev` runs `nest start --watch` with the cwd set to `apps/api`, and
 * the `.env` is at the root. That mismatch cost a morning: the API died with
 * "APP_KEY is not set", which reads like a missing secret and was really a
 * missing directory.
 */
import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ENV_FILES } from './env-files';

describe('where the API looks for .env', () => {
  it('includes the monorepo root, not just the working directory', () => {
    // The root is the directory holding pnpm-workspace.yaml. Finding it this
    // way rather than by counting "../" means the test still fails honestly
    // if someone moves apps/api.
    const root = ENV_FILES.map((f) => resolve(f, '..')).find((d) => existsSync(resolve(d, 'pnpm-workspace.yaml')));
    expect(root, `none of ${ENV_FILES.join(', ')} is beside pnpm-workspace.yaml`).toBeTruthy();
  });

  it('looks in the working directory first, so a local override wins', () => {
    expect(ENV_FILES[0]).toBe(resolve(process.cwd(), '.env'));
  });

  it('names real files, not a directory', () => {
    for (const f of ENV_FILES) expect(f.endsWith('.env'), f).toBe(true);
  });
});
