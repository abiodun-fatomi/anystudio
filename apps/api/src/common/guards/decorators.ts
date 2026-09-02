/**
 * Route decorators. Each one attaches metadata that the guards read; none of
 * them contains logic, so the rules stay in one place (guards + policy).
 */

import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Surface, StaffRole, WorkspaceRole } from '@prisma/client';
import type { SessionActor } from '../policy/policy';

export const META = {
  public: 'auth:public',
  surface: 'auth:surface',
  staff: 'auth:staff',
  workspaceRole: 'auth:workspaceRole',
  stepUp: 'auth:stepUpMinutes',
} as const;

/** No session required. Use sparingly; the default is authenticated. */
export const Public = () => SetMetadata(META.public, true);

/** The session must have been minted for this surface. */
export const RequireSurface = (s: Surface) => SetMetadata(META.surface, s);

/** An ADMIN-surface session with at least this staff role. */
export const RequireStaff = (min: StaffRole) => SetMetadata(META.staff, min);

/** Membership in the workspace named by `:workspaceId`, at least this role. */
export const RequireWorkspaceRole = (min: WorkspaceRole) => SetMetadata(META.workspaceRole, min);

/** A second factor confirmed within the last N minutes. */
export const RequireStepUp = (minutes = 5) => SetMetadata(META.stepUp, minutes);

/** The assembled Actor for this request. */
export const CurrentActor = createParamDecorator((_: unknown, ctx: ExecutionContext): SessionActor => {
  return ctx.switchToHttp().getRequest().actor;
});
