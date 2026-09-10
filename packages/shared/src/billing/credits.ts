/**
 * Credit constants the interface and the API must agree on.
 *
 * Per-action prices live in the database (CreditCost rows) so staff can
 * change them without a deploy. What lives HERE is the handful of numbers
 * that are promises made in product copy — "start with three free
 * generations" — and therefore change with the copy, in a pull request,
 * where a reviewer sees both sides move together.
 */

/**
 * Credits granted to a new personal workspace at signup.
 *
 * Sized to the landing page promise: three full product sheets (each sheet is
 * one branded image set + description + captions) at launch pricing, with a
 * little slack so the third one never fails on a rounding edge.
 */
export const SIGNUP_PROMO_CREDITS = 150;

/** Idempotency key for the signup grant, so a retried registration cannot double-credit. */
export const signupGrantKey = (workspaceId: string): string => `signup:${workspaceId}`;

/**
 * Idempotency key for a generation's debit.
 *
 * The generation id, not a random value: a client that retries a request it
 * already made — a double-tapped button, a flaky connection, a queue
 * redelivery — resolves to the same key and `ledger_apply` returns the
 * original row instead of spending twice.
 */
export const generationDebitKey = (generationId: string): string => `gen:${generationId}`;
