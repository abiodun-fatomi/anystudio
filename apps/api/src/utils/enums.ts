/**
 * Enumerations shared across modules. Database enums come from Prisma; these
 * are the application-level ones that never touch a column.
 */

/** What a verification email is for; changes only the wording. */
export enum VerificationFlavour {
  Welcome = 'welcome',
  Resend = 'resend',
}

/** Codes the Google callback can hand back to the sign-in page. */
export enum GoogleSignInError {
  Declined = 'google_declined',
  Expired = 'google_expired',
  State = 'google_state',
  Rejected = 'google_rejected',
  EmailUnverified = 'google_email_unverified',
  Unavailable = 'google_unavailable',
  MfaRequired = 'mfa_required',
}
