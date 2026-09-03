/** "/developers" — the platform and API story, for the engineer evaluating us. */
import { DEVELOPERS } from '@/content/developers';
import { staticPage } from '@/lib/static-page';

export const dynamic = 'force-dynamic';

export function GET(): Response {
  return staticPage(DEVELOPERS);
}
