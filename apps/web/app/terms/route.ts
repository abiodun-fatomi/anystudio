/** "/terms" — served from design/legal/terms.html through the landing chrome. */
import { TERMS } from '@/content/terms';
import { staticPage } from '@/lib/static-page';

export const dynamic = 'force-dynamic';

export function GET(): Response {
  return staticPage(TERMS);
}
