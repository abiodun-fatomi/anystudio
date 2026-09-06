/** "/why" — what the studio does for a person, a seller and a platform, and the mobile app. */
import { WHY } from '@/content/why';
import { staticPage } from '@/lib/static-page';

export const dynamic = 'force-dynamic';

export function GET(): Response {
  return staticPage(WHY);
}
