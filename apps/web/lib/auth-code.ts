/**
 * The box people type an authentication code into.
 *
 * It exists because "six digits" is true of some of these boxes and quietly
 * false of others, and a merchant typing `063296jjj` into a field that
 * happily accepts it is being set up to fail on submit for no reason.
 *
 * TWO KINDS, AND THE DIFFERENCE MATTERS
 * -------------------------------------
 *   'totp'      six digits, nothing else. The login challenge
 *               (`verifySecondFactor`) and enrolment (`confirmMfa`) both
 *               check the authenticator secret and nothing else, so a
 *               recovery code typed there was never going to work.
 *   'either'    a TOTP code OR an eight-character recovery code, because
 *               `verifyAnyFactor` takes both — disabling MFA, re-issuing
 *               recovery codes, and any step-up re-auth. Clamping these to
 *               six digits would take away the recovery path from someone
 *               who has already lost their phone, which is the one moment
 *               it exists for.
 *
 * Recovery codes are drawn from an unambiguous alphabet (no I, O, 0 or 1)
 * and compared upper-cased with spaces and dashes stripped, so this
 * normalises the same way as the server rather than rejecting a code the
 * server would have accepted.
 */

export type CodeAccepts = 'totp' | 'either';

/** What the server will actually look at, per kind. */
const RULES = {
  totp: { max: 6, keep: /[^0-9]/g, upper: false, mode: 'numeric' as const },
  either: { max: 8, keep: /[^0-9A-Za-z]/g, upper: true, mode: 'text' as const },
};

/**
 * Normalise a typed value to what the server would accept.
 *
 * Exported because this rule is the whole point of the component, and a
 * rule worth having is a rule worth testing directly.
 */
export function cleanCode(raw: string, accepts: CodeAccepts): string {
  const r = RULES[accepts];
  const stripped = raw.replace(r.keep, '');
  return (r.upper ? stripped.toUpperCase() : stripped).slice(0, r.max);
}
