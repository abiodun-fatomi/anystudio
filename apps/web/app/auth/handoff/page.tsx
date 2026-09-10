/**
 * /auth/handoff — the app host's half of a sign-in that happened on the
 * marketing host. Redeems the one-time token, which mints the session cookie
 * on this hostname, then goes where the sign-in was headed. Nothing to look
 * at; it is over in a round trip. A stale or reused link goes back to the
 * sign-in page rather than to an error.
 */
import { Suspense } from 'react';
import { HandoffClient } from './HandoffClient';

export const metadata = { title: 'Signing you in — AnyStudio', robots: { index: false } };

export default function HandoffPage() {
  return (
    <Suspense fallback={null}>
      <HandoffClient />
    </Suspense>
  );
}
