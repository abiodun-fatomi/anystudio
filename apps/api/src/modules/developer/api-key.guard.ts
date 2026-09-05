/**
 * The public API's door: `Authorization: Bearer as_live_…`.
 *
 * The session guard lets these routes through (@Public) and this one does
 * the real check: the key exists, is not revoked or expired, its project is
 * not archived, and it carries the scope the route declared. What it
 * attaches is an ordinary Actor for the key's workspace — MEMBER, no staff,
 * no MFA — so every service downstream applies the same rules it applies to
 * a person, plus the key itself for attribution and metering.
 *
 * Failures are logged with the key's prefix, never the key.
 */
import { type CanActivate, type ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { PrismaClient, type ApiKey } from '@prisma/client';
import { ForbiddenError, UnauthorizedError } from '../../../config/globals/errors';
import { authLog } from '../auth/auth.log';
import type { Actor } from '../auth/policy';
import { hashApiKey, looksLikeApiKey, type ApiScope } from './developer.types';

export const API_SCOPE_KEY = 'api:scope';
export const RequireScope = (scope: ApiScope) => SetMetadata(API_SCOPE_KEY, scope);

declare module 'express-serve-static-core' {
  interface Request { apiKey?: ApiKey }
}

/** How often lastUsedAt is written: once a minute per key is plenty for "is this key alive". */
const TOUCH_EVERY_MS = 60_000;

@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly touched = new Map<string, number>();

  constructor(private readonly reflector: Reflector, private readonly db: PrismaClient) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const header = req.get('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token || !looksLikeApiKey(token)) {
      authLog('api.auth', 'refused', { reason: token ? 'malformed_key' : 'no_key' }, req);
      throw new UnauthorizedError('Send your API key as "Authorization: Bearer as_live_…".');
    }
    const isProd = process.env.APP_ENV === 'production';
    if (isProd && token.startsWith('as_test_')) {
      authLog('api.auth', 'refused', { reason: 'test_key_in_production', prefix: token.slice(0, 16) }, req);
      throw new UnauthorizedError('That is a test key. Production takes live keys only.');
    }

    const key = await this.db.apiKey.findUnique({ where: { hash: hashApiKey(token) }, include: { project: { select: { archivedAt: true } }, workspace: { select: { deletedAt: true } } } });
    const refuse = (reason: string, message: string) => {
      authLog('api.auth', 'refused', { reason, prefix: token.slice(0, 16), apiKeyId: key?.id, workspaceId: key?.workspaceId }, req);
      throw new UnauthorizedError(message);
    };
    if (!key) refuse('unknown_key', 'That API key is not recognised.');
    if (key!.revokedAt) refuse('revoked', 'That API key was revoked.');
    if (key!.expiresAt && key!.expiresAt.getTime() < Date.now()) refuse('expired', 'That API key has expired.');
    if (key!.project.archivedAt) refuse('project_archived', 'The project this key belongs to is archived.');
    if (key!.workspace.deletedAt) refuse('workspace_deleted', 'That workspace no longer exists.');

    const scope = this.reflector.getAllAndOverride<ApiScope | undefined>(API_SCOPE_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (scope && !key!.scopes.includes(scope)) {
      authLog('api.auth', 'refused', { reason: 'missing_scope', scope, prefix: key!.prefix, apiKeyId: key!.id, workspaceId: key!.workspaceId }, req);
      throw new ForbiddenError(`This key does not have the "${scope}" scope.`);
    }

    const actor: Actor & { sessionId: string } = {
      userId: key!.createdById, surface: 'ORG', staffRole: null,
      workspaceRoles: new Map([[key!.workspaceId, 'MEMBER']]),
      mfaLevel: 0, lastStepUpAt: null, impersonating: false, sessionId: `key:${key!.id}`,
    };
    req.actor = actor;
    req.apiKey = key!;
    this.touch(key!.id);
    return true;
  }

  private touch(id: string): void {
    const last = this.touched.get(id) ?? 0;
    if (Date.now() - last < TOUCH_EVERY_MS) return;
    this.touched.set(id, Date.now());
    void this.db.apiKey.update({ where: { id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
  }
}
