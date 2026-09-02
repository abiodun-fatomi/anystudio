/**
 * The typed API client — the only place the web app talks HTTP.
 *
 * Every call goes to the same origin (/api/*), which Next rewrites to the
 * NestJS service, so cookies are first-party and there is no CORS dance.
 * Errors arrive as ApiError with the server's code and the request id, so a
 * screen can show "quote req_… to support" without knowing anything else.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
    readonly fields?: Array<{ path: string; message: string }>,
  ) {
    super(message);
  }
}

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/** One request. Throws ApiError on any non-2xx. */
async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'include',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new ApiError(
      res.status,
      String(data.code ?? 'http'),
      String(data.message ?? 'Something went wrong.'),
      typeof data.requestId === 'string' ? data.requestId : undefined,
      Array.isArray(data.fields) ? (data.fields as ApiError['fields']) : undefined,
    );
  }
  return data as T;
}

// ---------------------------------------------------------------- shapes

export interface Me {
  user: { id: string; name: string | null; email: string | null; phone: string | null };
  surface: 'APP' | 'ORG' | 'ADMIN';
  workspaces: Array<{ id: string; type: string; name: string; currency: string; role: string }>;
  canSwitchToStaff: boolean;
  mfaLevel: number;
}

export interface RegisterInput {
  name: string; email: string; phone: string; password: string;
  phoneIsWhatsApp: boolean;
  marketing: { granted: boolean; wording: string };
  sourceUrl?: string;
}

export type RegisterResult =
  | { status: 'signed_in'; next: string }
  | { status: 'conflict'; message: string }
  | { status: 'not_available' };

export type LoginResult =
  | { status: 'signed_in'; next: string }
  | { status: 'mfa_required'; challengeId: string; factors: string[] }
  | { status: 'invalid_credentials' };

export interface WorkspaceProfile {
  sells?: string;
  channels?: Array<'whatsapp' | 'instagram' | 'tiktok' | 'facebook' | 'jiji' | 'shop' | 'market'>;
  tone?: 'warm' | 'direct' | 'playful' | 'premium';
}

export interface Workspace {
  id: string; type: string; name: string; currency: string; region: string;
  profile: WorkspaceProfile | null; createdAt: string;
}

export interface WalletSummary { walletId: string; currency: string; balance: number }

export interface LedgerRow {
  id: string; kind: string; delta: number; balanceAfter: number; reason: string | null; createdAt: string;
}

// ---------------------------------------------------------------- calls

export const api = {
  auth: {
    /** Password step. May return mfa_required. */
    login: (identifier: string, password: string) =>
      request<LoginResult>('POST', '/auth/login', { identifier, password }),
    /** Second factor. */
    mfa: (challengeId: string, code: string) =>
      request<LoginResult>('POST', '/auth/login/mfa', { challengeId, code }),
    /** Create an account. 409 arrives as ApiError(409) — the caller shows the message. */
    register: (input: RegisterInput) => request<RegisterResult>('POST', '/auth/register', input),
    me: () => request<Me>('GET', '/auth/me'),
    logout: () => request<void>('POST', '/auth/logout'),
    /** Always resolves 'sent', whether or not the address exists. */
    forgot: (email: string) => request<{ status: 'sent' }>('POST', '/auth/forgot', { email }),
    reset: (token: string, password: string) =>
      request<{ status: 'reset' | 'invalid_token' }>('POST', '/auth/reset', { token, password }),
  },
  workspace: {
    get: (id: string) => request<Workspace>('GET', `/workspaces/${id}`),
    /** Merge-patch the welcome answers. */
    patchProfile: (id: string, patch: WorkspaceProfile) =>
      request<{ id: string; profile: WorkspaceProfile }>('PATCH', `/workspaces/${id}/profile`, patch),
  },
  wallet: {
    summary: (workspaceId: string) =>
      request<WalletSummary>('GET', `/workspaces/${workspaceId}/wallet`),
    history: (workspaceId: string, cursor?: string) =>
      request<{ rows: LedgerRow[]; nextCursor: string | null }>(
        'GET', `/workspaces/${workspaceId}/wallet/history${cursor ? `?cursor=${cursor}` : ''}`),
  },
};
