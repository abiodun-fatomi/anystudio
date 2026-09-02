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
 * Staging nests under dev.anystudio.ai rather than sitting beside production,
 * so no cookie can ever be shared between the two environments.
 */
export function surfaceForOrigin(origin: string, env: 'production' | 'dev' | 'local'): Surface | null {
  const host = (() => {
    try { return new URL(origin).host; } catch { return ''; }
  })();

  const map: Record<typeof env, Record<string, Surface>> = {
    production: {
      'app.anystudio.ai': 'APP',
      'org.anystudio.ai': 'ORG',
      'admin.anystudio.ai': 'ADMIN',
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
