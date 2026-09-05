/**
 * Result shapes the auth service returns to its controller. Discriminated on
 * `status` so a client switches on one field.
 */
import type { User } from '@prisma/client';

/**
 * A proven sign-in. `signed_in` means the session cookie is on this response;
 * `handoff` means the browser was on the marketing host and must visit `url`
 * (on the app host) to have its session minted there.
 */
export type SignedIn = { status: 'signed_in'; next: string } | { status: 'handoff'; url: string };

export type LoginResult =
  | SignedIn
  | { status: 'mfa_required'; challengeId: string; factors: string[] }
  | { status: 'invalid_credentials' };

export type MfaResult = SignedIn | { status: 'invalid_code' };

/** A duplicate email/phone is a 409 error, not a status here. */
export type RegisterResult = SignedIn | { status: 'not_available' };

export type RefreshResult =
  | { status: 'ok' }
  | { status: 'invalid' }
  | { status: 'reauthenticate'; reason: 'session_conflict' };

/** Internal: what verifyPassword hands back before a session exists. */
export type Verified =
  | { kind: 'rejected' }
  | { kind: 'mfa_required'; challengeId: string; factors: Array<'TOTP' | 'WEBAUTHN'> }
  | { kind: 'signed_in'; user: User; mfaLevel: number };
