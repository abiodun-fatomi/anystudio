/**
 * OpenNext → Cloudflare adapter settings.
 *
 * Deliberately empty. The portal has no ISR or on-demand revalidation yet, so
 * there is nothing to cache incrementally; wiring the R2 cache before it is
 * needed would only add a binding to reason about. When a marketing page with
 * ISR lands, this is where `incrementalCache` gets set.
 */
import { defineCloudflareConfig } from '@opennextjs/cloudflare';

export default defineCloudflareConfig({});
