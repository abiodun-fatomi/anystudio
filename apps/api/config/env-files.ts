/**
 * Where the API looks for its `.env`.
 *
 * There is one `.env` in this repo and it lives at the ROOT, because the API,
 * the worker and the tooling all read the same values and keeping three
 * copies in step is how a staging key ends up in a local run.
 *
 * `ConfigModule.forRoot()` on its own resolves `.env` against
 * `process.cwd()`. Run from the root — `node apps/api/dist/...` — that finds
 * it. Run the way anyone actually develops — `pnpm dev`, which is
 * `turbo run dev`, which runs `nest start --watch` with the cwd set to
 * `apps/api` — it does not, and the API dies at boot on the first thing it
 * needs:
 *
 *     FATAL: api failed to start   "APP_KEY is not set"
 *
 * which reads like a missing secret and is really a missing directory. So
 * both places are searched, nearest first, and a real environment that
 * injects variables directly (Render, CI) is unaffected — nothing here
 * overrides a variable that is already set.
 */
import { resolve } from 'node:path';

/** The monorepo root, from this file: apps/api/config → apps/api → apps → root. */
const repoRoot = resolve(__dirname, '..', '..', '..');

export const ENV_FILES: string[] = [
  // A per-app override, if someone ever wants one. Not committed, not required.
  resolve(process.cwd(), '.env'),
  resolve(repoRoot, '.env'),
];
