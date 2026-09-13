/**
 * Credit constants the interface and the API must agree on.
 *
 * Per-action prices live in the database (CreditCost rows) so staff can
 * change them without a deploy. What lives HERE is the handful of numbers
 * that are promises made in product copy — "start with 15 free images" —
 * and therefore change with the copy, in a pull request, where a reviewer
 * sees both sides move together.
 */

/**
 * Credits granted to a new personal workspace at signup.
 *
 * The grant has not changed; what it is CALLED has. This is three full product
 * sheets (a sheet being one branded image set + description + captions), and
 * it is also exactly fifteen branded images at `image.storefront`'s 10 credits
 * — the same number, counted in the unit a seller actually thinks in. "Three
 * generations" is our word for a bundle nobody outside this repo has heard of,
 * and it reads as five times smaller than the thing being given away, which is
 * an expensive way to describe your own generosity.
 *
 * Whoever changes this number changes the copy in `design/` in the same commit;
 * a reviewer should see both sides move or neither.
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
