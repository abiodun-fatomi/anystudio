/**
 * No two routes may answer the same request.
 *
 * WHY THIS EXISTS
 * ---------------
 * AccountController is mounted at `me` and declared `@Get('/notifications')`
 * for the notification SETTINGS. NotificationController is mounted at
 * `me/notifications` and declared `@Get()` for the bell's list. Both resolve
 * to `GET /api/v1/me/notifications`, Nest silently gives it to whichever
 * module was registered first, and Account won.
 *
 * So every request for the notification list came back as
 * `{ switches, emailMarketing, whatsappMarketing }`. The client reads `items`
 * off that, finds nothing, and shows an empty bell — next to a badge reading
 * 58, because `/me/notifications/unread` does not collide and had been
 * answering correctly all along. Nothing threw. Nothing logged. The only
 * evidence was a number that disagreed with a list, and no amount of reading
 * either file could explain it, because neither file was wrong on its own.
 *
 * A collision is a property of the SET of controllers, so it can only be
 * caught by a test that looks at all of them at once. This is that test: it
 * reads the same metadata Nest's router reads, builds every full path, and
 * fails on a duplicate — naming both sides, which is the part that takes an
 * afternoon to work out by hand.
 *
 * Parameter names are normalised (`:id` and `:userId` both become `:p`),
 * because Nest matches on shape: `/x/:id` and `/x/:userId` are the same
 * route and collide exactly as this pair did.
 */
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';

const SRC = resolve(__dirname, 'modules');

function controllerFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...controllerFiles(full));
    else if (name.endsWith('.controller.ts')) out.push(full);
  }
  return out;
}

/** "/me/sessions/:id" → "/me/sessions/:p" — Nest matches shape, not the name. */
const shape = (p: string) =>
  `/${p}`
    .replace(/\/+/g, '/')
    .replace(/:[^/]+/g, ':p')
    .replace(/\/$/, '') || '/';

const VERB = Object.fromEntries(Object.entries(RequestMethod).map(([k, v]) => [v, k])) as Record<number, string>;

describe('the route table', () => {
  // Importing every controller pulls in their services and Prisma; 5s is not
  // enough on a cold module graph, and this runs once.
  it('has no two handlers answering the same method and path', { timeout: 120_000 }, async () => {
    const seen = new Map<string, string>();
    const clashes: string[] = [];

    for (const file of controllerFiles(SRC)) {
      const mod: Record<string, unknown> = await import(file);
      for (const [exportName, value] of Object.entries(mod)) {
        if (typeof value !== 'function') continue;
        const base = Reflect.getMetadata(PATH_METADATA, value) as string | { path?: string } | undefined;
        if (base === undefined) continue;
        const basePath = typeof base === 'string' ? base : (base?.path ?? '');

        for (const key of Object.getOwnPropertyNames(value.prototype ?? {})) {
          if (key === 'constructor') continue;
          const handler = (value.prototype as Record<string, unknown>)[key];
          if (typeof handler !== 'function') continue;
          const sub = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
          const verb = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
          if (sub === undefined || verb === undefined) continue;

          const route = `${VERB[verb] ?? verb} ${shape(`${basePath}/${sub}`)}`;
          const owner = `${exportName}.${key}`;
          const already = seen.get(route);
          if (already) clashes.push(`${route}\n      ${already}\n      ${owner}`);
          else seen.set(route, owner);
        }
      }
    }

    expect(seen.size).toBeGreaterThan(50); // the walk found the controllers, not nothing
    expect(clashes, `two handlers answer the same request:\n\n    ${clashes.join('\n\n    ')}\n`).toEqual([]);
  });
});
