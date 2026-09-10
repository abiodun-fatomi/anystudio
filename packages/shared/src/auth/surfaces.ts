/**
 * The three surfaces, and the roles that exist on each.
 *
 * Kept here rather than imported from @prisma/client so the web apps can use
 * these types without pulling the database client into a browser bundle.
 * They must stay in step with schema.prisma — the enums there are the source
 * of truth, and CI's typecheck catches drift because the API imports both.
 */

export const SURFACES = ['APP', 'ORG', 'ADMIN'] as const;
export type Surface = (typeof SURFACES)[number];

export const STAFF_ROLES = ['SUPPORT', 'OPERATOR', 'ADMIN', 'SUPERADMIN'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export const WORKSPACE_ROLES = ['OWNER', 'ADMIN', 'MEMBER', 'BILLING', 'AUDITOR'] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

/**
 * Which host serves which surface. The API matches the request Origin against
 * this map; it never reads the surface from a request body, because a caller
 * must not be able to ask for an admin session by typing "ADMIN" into JSON.
 *
 * Development and staging nest under their own subdomain rather than sitting
 * beside production, so no cookie can ever be shared between environments.
 */
export type AppEnv = 'production' | 'staging' | 'dev' | 'local';

export function surfaceForOrigin(origin: string, env: AppEnv): Surface | null {
  const host = (() => {
    try {
      return new URL(origin).host;
    } catch {
      return '';
    }
  })();

  const map: Record<typeof env, Record<string, Surface>> = {
    production: {
      'app.anystudio.ai': 'APP',
      'org.anystudio.ai': 'ORG',
      'admin.anystudio.ai': 'ADMIN',
    },
    staging: {
      'app.staging.anystudio.ai': 'APP',
      'org.staging.anystudio.ai': 'ORG',
      'admin.staging.anystudio.ai': 'ADMIN',
    },
    dev: {
      'app.dev.anystudio.ai': 'APP',
      'org.dev.anystudio.ai': 'ORG',
      'admin.dev.anystudio.ai': 'ADMIN',
    },
    local: {
      'localhost:3000': 'APP',
      'localhost:3002': 'ORG',
      'localhost:3003': 'ADMIN',
    },
  };

  return map[env][host] ?? null;
}

/** The marketing hostname per environment — where the landing and the sign-in pages live. */
export function marketingHost(env: AppEnv): string {
  return ({ production: 'anystudio.ai', staging: 'staging.anystudio.ai', dev: 'dev.anystudio.ai', local: 'localhost:3000' } as Record<AppEnv, string>)[env];
}

/** True when a request comes from the marketing site (sign-in pages), which has no surface of its own. */
export function isMarketingOrigin(origin: string, env: AppEnv): boolean {
  let host = '';
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  if (env === 'local') return false; // locally the app host is the landing; no handoff needed
  const base = marketingHost(env);
  return host === base || host === `www.${base}`;
}

/** The APP surface's origin for the environment a marketing request came from. */
export function appOriginFor(env: AppEnv): string {
  return surfaceOriginFor('APP', env);
}

/** A surface's origin in an environment — the inverse of surfaceForOrigin. */
export function surfaceOriginFor(surface: Surface, env: AppEnv): string {
  if (env === 'local') return `http://localhost:${{ APP: 3000, ORG: 3002, ADMIN: 3003 }[surface]}`;
  return `https://${surface.toLowerCase()}.${marketingHost(env)}`;
}

/**
 * Which portal a workspace lives on. Organizations have their own hostname
 * (org.anystudio.ai) with its own session and its own cookie; businesses and
 * personal studios share app.anystudio.ai. Same build, different door.
 */
export function surfaceForWorkspaceType(type: string): 'APP' | 'ORG' {
  return type === 'ORGANIZATION' ? 'ORG' : 'APP';
}
