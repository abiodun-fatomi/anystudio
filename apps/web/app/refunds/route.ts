/** "/refunds" — served from design/legal/refunds.html through the landing chrome. */
import { REFUNDS } from '@/content/refunds';
import { staticPage } from '@/lib/static-page';

export const dynamic = 'force-dynamic';

export function GET(): Response {
  return staticPage(REFUNDS);
}
