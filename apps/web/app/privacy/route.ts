/** "/privacy" — served from design/legal/privacy.html through the landing chrome. */
import { PRIVACY } from '@/content/privacy';
import { staticPage } from '@/lib/static-page';

export const dynamic = 'force-dynamic';

export function GET(): Response {
  return staticPage(PRIVACY);
}
