/** "/pricing" — plans and credit costs (the prototype section, served verbatim). */
import { PRICING } from '@/content/pricing';
import { staticPage } from '@/lib/static-page';

export const dynamic = 'force-dynamic';

export function GET(): Response {
  return staticPage(PRICING);
}
