/**
 * Result shapes the auth service returns to its controller. Discriminated on
 * `status` so a client switches on one field.
 */
import type { User } from '@prisma/client';

export type LoginResult =
  | { status: 'signed_in'; next: string }
  | { status: 'mfa_required'; challengeId: string; factors: string[] }
  | { status: 'invalid_credentials' };

export type MfaResult = { status: 'signed_in'; next: string } | { status: 'invalid_code' };

/** A duplicate email/phone is a 409 error, not a status here. */
export type RegisterResult = { status: 'signed_in'; next: string } | { status: 'not_available' };

export type RefreshResult =
  | { status: 'ok' }
  | { status: 'invalid' }
  | { status: 'reauthenticate'; reason: 'session_conflict' };

/** Internal: what verifyPassword hands back before a session exists. */
export type Verified =
  | { kind: 'rejected' }
  | { kind: 'mfa_required'; challengeId: string; factors: Array<'TOTP' | 'WEBAUTHN'> }
  | { kind: 'signed_in'; user: User; mfaLevel: number };
