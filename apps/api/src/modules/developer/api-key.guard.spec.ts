/** The guard against a fake table of keys: who gets in, who is told why not. */
import { describe, expect, it } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { PrismaClient } from '@prisma/client';
import { ApiKeyGuard, API_SCOPE_KEY } from './api-key.guard';
import { mintApiKey } from './developer.types';

const live = mintApiKey('test');
const revoked = mintApiKey('test');
const rows = [
  {
    id: 'k1',
    workspaceId: 'w1',
    projectId: 'p1',
    createdById: 'u1',
    hash: live.hash,
    prefix: live.prefix,
    scopes: ['generations:write', 'catalogue:read'],
    revokedAt: null,
    expiresAt: null,
    project: { archivedAt: null },
    workspace: { deletedAt: null },
  },
  {
    id: 'k2',
    workspaceId: 'w1',
    projectId: 'p1',
    createdById: 'u1',
    hash: revoked.hash,
    prefix: revoked.prefix,
    scopes: ['generations:write'],
    revokedAt: new Date(),
    expiresAt: null,
    project: { archivedAt: null },
    workspace: { deletedAt: null },
  },
];
const db = {
  apiKey: { findUnique: async ({ where }: { where: { hash: string } }) => rows.find((r) => r.hash === where.hash) ?? null, update: async () => ({}) },
} as unknown as PrismaClient;

function ctx(authorization: string | undefined, scope?: string): { ctx: ExecutionContext; req: Record<string, unknown> } {
  const req: Record<string, unknown> = { get: (h: string) => (h.toLowerCase() === 'authorization' ? authorization : undefined), ip: '1.1.1.1', requestId: 'r' };
  const reflector = { getAllAndOverride: (key: string) => (key === API_SCOPE_KEY ? scope : undefined) } as unknown as Reflector;
  const c = { switchToHttp: () => ({ getRequest: () => req }), getHandler: () => undefined, getClass: () => undefined } as unknown as ExecutionContext;
  return { ctx: c, req: Object.assign(req, { __reflector: reflector }) };
}

function guardWith(scope?: string): ApiKeyGuard {
  const reflector = { getAllAndOverride: (key: string) => (key === API_SCOPE_KEY ? scope : undefined) } as unknown as Reflector;
  return new ApiKeyGuard(reflector, db);
}

describe('ApiKeyGuard', () => {
  it('admits a live key with the scope and attaches a MEMBER actor for its workspace', async () => {
    const { ctx: c, req } = ctx(`Bearer ${live.key}`);
    expect(await guardWith('generations:write').canActivate(c)).toBe(true);
    const actor = req.actor as { userId: string; surface: string; workspaceRoles: Map<string, string> };
    expect(actor.userId).toBe('u1');
    expect(actor.surface).toBe('ORG');
    expect(actor.workspaceRoles.get('w1')).toBe('MEMBER');
    expect((req.apiKey as { id: string }).id).toBe('k1');
  });

  it('refuses a missing, malformed, unknown or revoked key with 401, and a missing scope with 403', async () => {
    await expect(guardWith().canActivate(ctx(undefined).ctx)).rejects.toMatchObject({ status: 401 });
    await expect(guardWith().canActivate(ctx('Bearer nope').ctx)).rejects.toMatchObject({ status: 401 });
    await expect(guardWith().canActivate(ctx(`Bearer ${mintApiKey('test').key}`).ctx)).rejects.toMatchObject({
      status: 401,
      message: expect.stringContaining('not recognised'),
    });
    await expect(guardWith().canActivate(ctx(`Bearer ${revoked.key}`).ctx)).rejects.toMatchObject({ status: 401, message: expect.stringContaining('revoked') });
    await expect(guardWith('media:write').canActivate(ctx(`Bearer ${live.key}`).ctx)).rejects.toMatchObject({ status: 403 });
  });
});
