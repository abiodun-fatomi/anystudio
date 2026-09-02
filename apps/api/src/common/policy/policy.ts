/**
 * The policy layer.
 *
 * Every authorization question in the product is answered here, by one function,
 * so the rules are readable in one place instead of being scattered across
 * controllers where nobody can audit them.
 *
 * The rule that motivated this file: a person can hold BOTH a staff grant and
 * their own customer workspace. That is a deliberate product decision — one
 * identity, one set of credentials, both roles. It also creates an obvious
 * conflict of interest, and trust is not a control. So `assertNoSelfDealing`
 * exists, it runs on every staff mutation, and it is not optional.
 */

import { Surface, StaffRole, WorkspaceRole } from '@anystudio/shared';

/** Staff roles in ascending order of authority. */
const STAFF_RANK: Record<StaffRole, number> = {
  SUPPORT: 1,
  OPERATOR: 2,
  ADMIN: 3,
  SUPERADMIN: 4,
};

/**
 * Everything the policy layer is allowed to consider. Assembled once per
 * request by the session guard; nothing here is read from the request body,
 * because a caller must never be able to describe their own authority.
 */
export interface Actor {
  userId: string;
  /** The surface this session was minted for. Never inferred from the Host header. */
  surface: Surface;
  /** Active, unexpired staff grant, if any. */
  staffRole: StaffRole | null;
  /** Workspaces this person belongs to, and as what. */
  workspaceRoles: ReadonlyMap<string, WorkspaceRole>;
  /** 0 password only · 1 a confirmed factor · 2 a factor within the step-up window. */
  mfaLevel: number;
  /** When they last completed a fresh factor. Null means never in this session. */
  lastStepUpAt: Date | null;
  /** True while acting as a customer for support purposes. Read-only by design. */
  impersonating: boolean;
}

export class PolicyError extends Error {
  constructor(
    readonly code:
      | 'WRONG_SURFACE'
      | 'NOT_STAFF'
      | 'INSUFFICIENT_STAFF_ROLE'
      | 'NOT_A_MEMBER'
      | 'INSUFFICIENT_WORKSPACE_ROLE'
      | 'STEP_UP_REQUIRED'
      | 'SELF_DEALING'
      | 'READ_ONLY_IMPERSONATION',
    message: string,
  ) {
    super(message);
  }
}

/**
 * A session minted for one surface is worthless on another.
 *
 * This is the single most important check in the file. It is what makes an
 * app.anystudio.ai session useless at admin.anystudio.ai even though both
 * belong to the same person with the same password — so an XSS on the customer
 * app cannot reach the staff console.
 */
export function assertSurface(actor: Actor, required: Surface): void {
  if (actor.surface !== required) {
    throw new PolicyError(
      'WRONG_SURFACE',
      `This session is for ${actor.surface} and cannot be used on ${required}. Sign in again on that surface.`,
    );
  }
}

/** Requires an active staff grant of at least `min`. */
export function assertStaff(actor: Actor, min: StaffRole): void {
  assertSurface(actor, 'ADMIN');
  if (!actor.staffRole) {
    throw new PolicyError('NOT_STAFF', 'This account has no staff access.');
  }
  if (STAFF_RANK[actor.staffRole] < STAFF_RANK[min]) {
    throw new PolicyError(
      'INSUFFICIENT_STAFF_ROLE',
      `Requires ${min}; this account is ${actor.staffRole}.`,
    );
  }
}

/**
 * THE CONFLICT-OF-INTEREST RULE.
 *
 * Staff may not act on a workspace they are a member of. Without this, an
 * OPERATOR could refund credits to their own account, raise their own limits or
 * clear their own abuse flags — and every one of those would look like ordinary,
 * correctly-authorised work in the audit log.
 *
 * Escalation path when it fires: another staff member does it. That is the
 * point. It costs a message in a channel and removes an entire category of
 * insider risk.
 */
export function assertNoSelfDealing(actor: Actor, targetWorkspaceId: string): void {
  if (actor.workspaceRoles.has(targetWorkspaceId)) {
    throw new PolicyError(
      'SELF_DEALING',
      'You belong to this workspace, so you cannot action it from the staff console. Ask another staff member.',
    );
  }
}

/**
 * Recent-factor requirement for anything expensive or irreversible: moving
 * money, changing a role, revealing a key, deleting an organization.
 *
 * A session being old is not the issue — an unattended session is. Re-proving a
 * factor costs the real operator six seconds and costs someone at a borrowed
 * desk everything.
 */
export function assertStepUp(actor: Actor, withinMinutes = 5): void {
  if (actor.mfaLevel < 1) {
    throw new PolicyError('STEP_UP_REQUIRED', 'Confirm your second factor to continue.');
  }
  const at = actor.lastStepUpAt?.getTime() ?? 0;
  if (Date.now() - at > withinMinutes * 60_000) {
    throw new PolicyError(
      'STEP_UP_REQUIRED',
      `Confirm your second factor — it was last checked more than ${withinMinutes} minutes ago.`,
    );
  }
}

const WORKSPACE_RANK: Record<WorkspaceRole, number> = {
  AUDITOR: 1,
  BILLING: 1,
  MEMBER: 2,
  ADMIN: 3,
  OWNER: 4,
};

/**
 * Membership check for customer-side surfaces.
 *
 * BILLING and AUDITOR deliberately share rank 1 with each other rather than
 * sitting on the ladder: they are narrow roles, not junior ones. Anything that
 * needs "at least MEMBER" excludes them, which is correct — a billing contact
 * should not be able to spend credits.
 */
export function assertWorkspaceRole(
  actor: Actor,
  workspaceId: string,
  min: WorkspaceRole,
): void {
  const role = actor.workspaceRoles.get(workspaceId);
  if (!role) {
    throw new PolicyError('NOT_A_MEMBER', 'You do not have access to this workspace.');
  }
  if (WORKSPACE_RANK[role] < WORKSPACE_RANK[min]) {
    throw new PolicyError(
      'INSUFFICIENT_WORKSPACE_ROLE',
      `Requires ${min}; you are ${role} in this workspace.`,
    );
  }
}

/**
 * Impersonation is for looking, never for doing.
 *
 * Support needs to see what the customer sees. Support does not need to act as
 * them — an action taken while impersonating is indistinguishable from the
 * customer's own action afterwards, which destroys the evidentiary value of
 * every other log we keep.
 */
export function assertNotImpersonating(actor: Actor): void {
  if (actor.impersonating) {
    throw new PolicyError(
      'READ_ONLY_IMPERSONATION',
      'You are viewing this account as support. Impersonation is read-only.',
    );
  }
}

/** Convenience wrapper for the common staff-mutation shape. */
export function assertStaffMutation(
  actor: Actor,
  opts: { min: StaffRole; workspaceId?: string; stepUpMinutes?: number },
): void {
  assertStaff(actor, opts.min);
  assertNotImpersonating(actor);
  if (opts.workspaceId) assertNoSelfDealing(actor, opts.workspaceId);
  assertStepUp(actor, opts.stepUpMinutes ?? 5);
}
