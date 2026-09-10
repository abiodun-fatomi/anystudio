/**
 * Sibling hostnames, derived — never configured.
 *
 * Every environment follows one shape: a base (`anystudio.ai`,
 * `dev.anystudio.ai`, `staging.anystudio.ai`) with the surfaces as prefixes
 * (`app.`, `api.`, `admin.`, `org.`). So the portal never needs to be told
 * where its API is: strip its own prefix, add another. This is what lets one
 * build serve every environment with no build-time variables at all.
 *
 * Runs in the middleware (Workers runtime) and in the browser, so: no Node
 * APIs, no imports.
 */

export type Surface = 'app' | 'api' | 'admin' | 'org' | '';

const SURFACES = ['app', 'api', 'admin', 'org'] as const;

/** Local ports, mirrored from README "Running it locally". */
const LOCAL_PORTS: Record<Exclude<Surface, ''>, number> = { app: 3000, api: 3001, org: 3002, admin: 3003 };

export const isLocalHost = (host: string): boolean => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);

/** `app.dev.anystudio.ai` → `dev.anystudio.ai`; `anystudio.ai` → `anystudio.ai`. */
export function baseHost(host: string): string {
  for (const s of SURFACES) if (host.startsWith(`${s}.`)) return host.slice(s.length + 1);
  return host.startsWith('www.') ? host.slice(4) : host;
}

/** The origin of another surface in the same environment as `host`. */
export function siblingOrigin(host: string, surface: Surface): string {
  if (isLocalHost(host)) {
    return surface === '' ? `http://localhost:${LOCAL_PORTS.app}` : `http://localhost:${LOCAL_PORTS[surface]}`;
  }
  const base = baseHost(host);
  return `https://${surface ? `${surface}.` : ''}${base}`;
}

/**
 * The portal a hostname serves: organizations on `org.`, everything else on
 * `app.`. Locally there is one host and it serves both.
 */
export function portalOf(host: string): 'APP' | 'ORG' {
  return host.startsWith('org.') ? 'ORG' : 'APP';
}
