/**
 * The one guard.
 *
 * Resolves the session cookie for the calling surface, assembles the Actor,
 * then applies whatever the route declared: surface, staff role, workspace
 * role, step-up. Everything a route can require is enforced here, in one
 * order, so no controller can forget a check by forgetting a decorator's
 * sibling.
 *
 * Every refusal is a PolicyError or UnauthorizedError; the exception filter
 * turns them into responses. The guard never writes an HTTP status itself.
 */

import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { Surface, StaffRole, WorkspaceRole } from '@prisma/client';
import { META } from './decorators';
import { AuthService } from '../../modules/auth/auth.service';
import { SessionService, COOKIE } from '../../modules/auth/session.service';
import { UnauthorizedError } from '../errors/app-error';
import { assertStaff, assertStepUp, assertSurface, assertWorkspaceRole, type Actor } from '../policy/policy';

declare module 'express-serve-static-core' {
  interface Request { actor?: Actor & { sessionId: string } }
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
  ) {}

  /** Authenticates, assembles the actor, then enforces the route's declared requirements in order. */
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(META.public, targets)) return true;

    const req = ctx.switchToHttp().getRequest<Request>();
    const surface = this.auth.surfaceFromOrigin(req);

    const token = req.cookies?.[COOKIE[surface]];
    if (!token) throw new UnauthorizedError();
    const session = await this.sessions.resolve(token, surface);
    if (!session) throw new UnauthorizedError();

    const actor = await this.auth.actorFor(session.userId, surface, session);
    req.actor = actor;

    const wantSurface = this.reflector.getAllAndOverride<Surface>(META.surface, targets);
    if (wantSurface) assertSurface(actor, wantSurface);

    const wantStaff = this.reflector.getAllAndOverride<StaffRole>(META.staff, targets);
    if (wantStaff) assertStaff(actor, wantStaff);

    const wantWs = this.reflector.getAllAndOverride<WorkspaceRole>(META.workspaceRole, targets);
    if (wantWs) {
      const wsId = req.params.workspaceId;
      if (!wsId) throw new UnauthorizedError();
      assertWorkspaceRole(actor, wsId, wantWs);
    }

    const stepUp = this.reflector.getAllAndOverride<number>(META.stepUp, targets);
    if (stepUp !== undefined) assertStepUp(actor, stepUp);

    return true;
  }
}
