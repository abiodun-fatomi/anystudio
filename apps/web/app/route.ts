/**
 * "/" — the landing page, on the marketing host. On the app host the
 * middleware has already sent "/" to /today, so this never runs there.
 */
import { LANDING } from '@/content/landing';
import { staticPage } from '@/lib/static-page';

export const dynamic = 'force-dynamic';

export function GET(): Response {
  return staticPage(LANDING);
}
