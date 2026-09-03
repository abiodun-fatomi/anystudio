/**
 * Authorization requirements, declared on the handler so the policy is visible
 * where the route is and enforced by one guard. None of them contains logic —
 * the rules live in policy.ts and the guard applies them in a fixed order.
 */
import { SetMetadata } from '@nestjs/common';
import type { Surface, StaffRole, WorkspaceRole } from '@prisma/client';

export const META = {
  surface: 'auth:surface',
  staff: 'auth:staff',
  workspaceRole: 'auth:workspaceRole',
  stepUp: 'auth:stepUp',
} as const;

/** The session must have been minted for this surface. */
export const RequireSurface = (surface: Surface) => SetMetadata(META.surface, surface);

/** An active staff grant of at least this rank; implies the ADMIN surface. */
export const RequireStaff = (min: StaffRole) => SetMetadata(META.staff, min);

/** Membership of `:workspaceId` at or above this role. */
export const RequireWorkspaceRole = (min: WorkspaceRole) => SetMetadata(META.workspaceRole, min);

/** A second factor confirmed within the last N minutes. */
export const RequireStepUp = (minutes = 5) => SetMetadata(META.stepUp, minutes);
