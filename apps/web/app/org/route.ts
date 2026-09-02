/** "/org" — the organization sign-up page (prototype served verbatim). */
import { ORG } from '@/content/org';
import { staticPage } from '@/lib/static-page';

export const dynamic = 'force-dynamic';

export function GET(): Response {
  return staticPage(ORG);
}
