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

/**
 * Every response is an envelope: `{ status, message, data }` on success,
 * `{ status, message, error, data: null, fields?, requestId }` on failure.
 * Callers get `data` back; the envelope is unwrapped here and nowhere else.
 */
interface Envelope<T> { status: number; message: string; data: T; error?: string;
  fields?: Array<{ path: string; message: string }>; requestId?: string }

const BASE = '/api/v1';

/** One request. Throws ApiError on any non-2xx. */
async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    credentials: 'include',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const env = (await res.json().catch(() => ({}))) as Partial<Envelope<T>>;
  if (!res.ok) {
    throw new ApiError(res.status, env.error ?? 'http', env.message ?? 'Something went wrong.', env.requestId, env.fields);
  }
  return env.data as T;
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

/** A duplicate email/phone arrives as ApiError(409, 'conflict'), not as a status. */
export type RegisterResult = { status: 'signed_in'; next: string } | { status: 'not_available' };

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

export type GenerationStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';

export interface GenerationRow {
  id: string; workspaceId: string; capability: string; kind: 'STANDALONE' | 'PARENT' | 'CHILD'; parentId: string | null;
  costCode: string; credits: number; status: GenerationStatus; providerKey: string | null;
  input: Record<string, unknown>; outputs: GenerationOutputRow[] | null;
  stage: string | null; progress: number; failureKind: string | null; createdAt: string; startedAt: string | null; finishedAt: string | null;
  children?: GenerationRow[];
}

export interface GenerationOutputRow {
  key: string; role: 'image' | 'variant' | 'video' | 'audio' | 'text' | 'thumb' | 'mask'; mime: string;
  bytes?: number; width?: number; height?: number; durationMs?: number; size?: string; text?: unknown;
}

export interface GenerationView { generation: GenerationRow; message?: string }
export interface GenerationResult { generation: GenerationRow; balance: number }
export interface Quote { costCode: string; credits: number; label: string; balance: number; balanceAfter: number; expectedMs: number }

export interface MediaAssetRow {
  id: string; workspaceId: string; kind: 'SOURCE' | 'OUTPUT' | 'DERIVED'; status: 'PENDING' | 'READY' | 'REJECTED';
  key: string; mime: string | null; bytes: number | null; width: number | null; height: number | null; filename: string | null; createdAt: string;
}

export interface PresignedUpload { assetId: string; key: string; url: string; method: 'PUT'; headers: Record<string, string>; expiresInSec: number }

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
    verify: (token: string) => request<{ status: 'verified' | 'invalid_token' }>('POST', '/auth/verify', { token }),
    resendVerification: () => request<{ status: 'sent' }>('POST', '/auth/verify/resend'),
    reset: (token: string, password: string) =>
      request<{ status: 'reset' | 'invalid_token' }>('POST', '/auth/reset', { token, password }),
  },
  workspace: {
    get: (id: string) => request<Workspace>('GET', `/workspaces/${id}`),
    /** Merge-patch the welcome answers. */
    patchProfile: (id: string, patch: WorkspaceProfile) =>
      request<{ id: string; profile: WorkspaceProfile }>('PATCH', `/workspaces/${id}/profile`, patch),
  },
  media: {
    presign: (workspaceId: string, file: { filename: string; mime: string; bytes: number }) =>
      request<PresignedUpload>('POST', `/workspaces/${workspaceId}/media/uploads`, file),
    complete: (workspaceId: string, assetId: string) =>
      request<MediaAssetRow>('POST', `/workspaces/${workspaceId}/media/uploads/complete`, { assetId }),
    list: (workspaceId: string, opts: { kind?: 'SOURCE' | 'OUTPUT'; cursor?: string; take?: number } = {}) => {
      const q = new URLSearchParams();
      if (opts.kind) q.set('kind', opts.kind);
      if (opts.cursor) q.set('cursor', opts.cursor);
      if (opts.take) q.set('take', String(opts.take));
      return request<MediaAssetRow[]>('GET', `/workspaces/${workspaceId}/media${q.size ? `?${q}` : ''}`);
    },
    urls: (workspaceId: string, keys: string[]) =>
      request<{ urls: Record<string, string>; expiresInSec: number }>('POST', `/workspaces/${workspaceId}/media/urls`, { keys }),
    remove: (workspaceId: string, assetId: string) => request<{ deleted: true }>('DELETE', `/workspaces/${workspaceId}/media/${assetId}`),
  },
  generations: {
    quote: (workspaceId: string, capability: string, costCode?: string) =>
      request<Quote>('GET', `/workspaces/${workspaceId}/generations/quote?capability=${capability}${costCode ? `&costCode=${costCode}` : ''}`),
    create: (workspaceId: string, body: { capability: string; params: Record<string, unknown>; clientKey: string; costCode?: string }) =>
      request<GenerationResult>('POST', `/workspaces/${workspaceId}/generations`, body),
    get: (workspaceId: string, id: string) => request<GenerationView>('GET', `/workspaces/${workspaceId}/generations/${id}`),
    history: (workspaceId: string, cursor?: string) =>
      request<GenerationRow[]>('GET', `/workspaces/${workspaceId}/generations${cursor ? `?cursor=${cursor}` : ''}`),
    cancel: (workspaceId: string, id: string) => request<GenerationRow>('POST', `/workspaces/${workspaceId}/generations/${id}/cancel`),
    /** Same-origin, so the session cookie rides along with EventSource. */
    streamUrl: (workspaceId: string, id: string) => `${BASE}/workspaces/${workspaceId}/generations/${id}/stream`,
  },
  wallet: {
    summary: (workspaceId: string) =>
      request<WalletSummary>('GET', `/workspaces/${workspaceId}/wallet`),
    history: (workspaceId: string, cursor?: string) =>
      request<{ rows: LedgerRow[]; nextCursor: string | null }>(
        'GET', `/workspaces/${workspaceId}/wallet/history${cursor ? `?cursor=${cursor}` : ''}`),
  },
};
