/**
 * Constants with a single source of truth. Anything a client also needs lives
 * in @anystudio/shared instead, so both sides import the same value.
 */

export const MESSAGES = {
  SIGNED_IN: 'Signed in',
  MFA_REQUIRED: 'A second factor is required',
  INVALID_CREDENTIALS: 'Those details did not match an account',
  INVALID_CODE: 'That code did not match',
  REGISTERED: 'Account created',
  CONFLICT: 'An account already exists with those details. Try signing in.',
  RESET_SENT: 'If that address has an account, a reset link is on its way',
  RESET_DONE: 'Password changed. Every session has been signed out.',
  VERIFIED: 'Email confirmed',
  VERIFICATION_SENT: 'A fresh confirmation link is on its way',
  INVALID_TOKEN: 'That link is not valid any more',
  OK: 'OK',
} as const;

/** The path Google returns the browser to, relative to the app's own origin. */
export const GOOGLE_CALLBACK_PATH = '/api/v1/auth/google/callback';
