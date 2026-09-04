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

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

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
  user: { id: string; name: string | null; email: string | null; phone: string | null; avatarKey?: string | null; locale?: string | null; timezone?: string | null; deleteRequestedAt?: string | null };
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

export interface BrandKitRow {
  workspaceId: string; businessName?: string | null; logoKey?: string | null; palette?: string[] | null;
  fontDisplay?: string | null; fontBody?: string | null; tone?: string | null;
  watermark?: { enabled?: boolean; position?: 'tr' | 'tl' | 'br' | 'bl'; opacity?: number } | null;
  showPrice?: boolean; defaultSizes?: string[] | null; empty?: true;
}

export interface LedgerRow {
  id: string; kind: string; delta: number; balanceAfter: number; reason: string | null; createdAt: string;
}

// ---------------------------------------------------------------- calls

// ---------------------------------------------------------------- account

export interface Profile {
  id: string; name: string | null; email: string | null; emailVerifiedAt: string | null; phone: string | null; phoneVerifiedAt: string | null;
  phoneIsWhatsApp: boolean; avatarKey: string | null; avatarUrl: string | null; locale: string | null; timezone: string | null;
  createdAt: string; lastLoginAt: string | null; hasPassword: boolean;
  mfa: { enabled: boolean; factors: Array<{ id: string; type: string; label: string | null; confirmedAt: string | null; lastUsedAt: string | null }>; recoveryCodesLeft: number };
  identities: Array<{ id: string; provider: 'PASSWORD' | 'GOOGLE' | 'WHATSAPP' | 'PASSKEY'; label: string | null; lastUsedAt: string | null; createdAt: string }>;
  pendingEmail: { email: string | null; expiresAt: string } | null;
  deletion: { requestedAt: string; deleteOn: string } | null;
}
export interface SessionRow { id: string; surface: string; userAgent: string | null; geoLabel: string | null; createdAt: string; lastSeenAt: string; current: boolean; device: string | null }
export interface ActivityRow { id: string; type: string; surface: string | null; ip: string | null; userAgent: string | null; detail: Record<string, unknown> | null; createdAt: string; device: string | null }
export interface NotificationSwitches { generationDoneEmail: boolean; generationDoneWhatsApp: boolean; lowCreditsEmail: boolean; weeklyDigest: boolean }
export interface ConsentState { granted: boolean; wording: string | null; at: string | null }
export interface Notifications { switches: NotificationSwitches; emailMarketing: ConsentState; whatsappMarketing: ConsentState }
export interface Reauth { currentPassword?: string; code?: string }
export interface MemberRow { userId: string; role: string; joinedAt: string; name: string | null; email: string | null; lastLoginAt: string | null }
export interface InviteRow { id: string; email: string | null; role: string; expiresAt: string; createdAt: string }
export type GrantableRole = 'ADMIN' | 'MEMBER' | 'BILLING' | 'AUDITOR';

// ---------------------------------------------------------------- billing

export type PaymentProvider = 'FLUTTERWAVE' | 'PADDLE' | 'STUB';
export interface PriceOffer { price: number | null; canBuy: boolean }
export interface Catalogue {
  currency: string; provider: PaymentProvider | null; available: boolean;
  packs: Array<{ code: string; credits: number; price: number | null; canBuy: boolean }>;
  plans: Array<{ code: string; credits: number; month: PriceOffer; year: PriceOffer | null; current: boolean }>;
  subscription: SubscriptionView | null;
}
export interface SubscriptionView { id: string; planCode: string; interval: string; status: 'ACTIVE' | 'PAST_DUE' | 'CANCELLED' | 'PAUSED'; provider: PaymentProvider; currentPeriodStart: string | null; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean; cancelledAt: string | null }
export interface PaymentView {
  id: string; reference: string; provider: PaymentProvider; kind: 'PACK' | 'SUBSCRIPTION' | 'RENEWAL'; status: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'REFUNDED';
  itemCode: string; interval: string | null; credits: number; amountMinor: number; currency: string; checkoutUrl: string | null; failureReason: string | null; refundedAt: string | null; createdAt: string; updatedAt: string;
}
export interface CheckoutOut { paymentId: string; reference: string; provider: PaymentProvider; url: string; credits: number; amountMinor: number; currency: string }

export const api = {
  billing: {
    catalogue: (workspaceId: string) => request<Catalogue>('GET', `/workspaces/${workspaceId}/billing/catalogue`),
    checkout: (workspaceId: string, body: { kind: 'pack' | 'plan'; code: string; interval?: 'month' | 'year' }) => request<CheckoutOut>('POST', `/workspaces/${workspaceId}/billing/checkout`, body),
    verify: (workspaceId: string, paymentId: string, providerRef?: string) => request<PaymentView>('POST', `/workspaces/${workspaceId}/billing/payments/${paymentId}/verify`, providerRef ? { providerRef } : {}),
    payment: (workspaceId: string, paymentId: string) => request<PaymentView>('GET', `/workspaces/${workspaceId}/billing/payments/${paymentId}`),
    payments: (workspaceId: string, cursor?: string) => request<{ rows: PaymentView[]; nextCursor: string | null }>('GET', `/workspaces/${workspaceId}/billing/payments${cursor ? `?cursor=${cursor}` : ''}`),
    subscription: (workspaceId: string) => request<SubscriptionView | null>('GET', `/workspaces/${workspaceId}/billing/subscription`),
    cancel: (workspaceId: string) => request<SubscriptionView>('POST', `/workspaces/${workspaceId}/billing/subscription/cancel`),
  },
  account: {
    profile: () => request<Profile>('GET', '/me/profile'),
    updateProfile: (patch: { name?: string; avatarKey?: string | null; locale?: string | null; timezone?: string | null }) =>
      request<{ id: string; name: string | null; avatarKey: string | null; locale: string | null; timezone: string | null }>('PATCH', '/me/profile', patch),
    requestEmailChange: (email: string, reauth: Reauth) => request<{ status: 'sent' }>('POST', '/me/email', { email, ...reauth }),
    confirmEmailChange: (token: string) => request<{ status: 'changed' | 'invalid_token' }>('POST', '/me/email/confirm', { token }),
    changePassword: (newPassword: string, reauth: Reauth) => request<{ status: 'changed'; otherSessionsEnded: number }>('POST', '/me/password', { newPassword, ...reauth }),
    mfaEnrol: () => request<{ factorId: string; secret: string; uri: string }>('POST', '/me/mfa/enrol'),
    mfaConfirm: (code: string) => request<{ status: 'enabled'; recoveryCodes: string[] }>('POST', '/me/mfa/confirm', { code }),
    mfaDisable: (reauth: Reauth) => request<{ status: 'disabled' }>('DELETE', '/me/mfa', reauth),
    recoveryCodes: (code: string) => request<{ recoveryCodes: string[] }>('POST', '/me/mfa/recovery-codes', { code }),
    sessions: () => request<SessionRow[]>('GET', '/me/sessions'),
    revokeSession: (id: string) => request<{ status: 'revoked' }>('DELETE', `/me/sessions/${id}`),
    revokeOtherSessions: () => request<{ status: 'revoked'; count: number }>('POST', '/me/sessions/revoke-others'),
    unlinkIdentity: (id: string) => request<{ status: 'unlinked' }>('DELETE', `/me/identities/${id}`),
    activity: () => request<ActivityRow[]>('GET', '/me/security/activity'),
    notifications: () => request<Notifications>('GET', '/me/notifications'),
    updateNotifications: (body: { switches?: Partial<NotificationSwitches>; emailMarketing?: { granted: boolean; wording: string }; whatsappMarketing?: { granted: boolean; wording: string }; sourceUrl?: string }) =>
      request<Notifications>('PUT', '/me/notifications', body),
    export: () => request<Record<string, unknown>>('GET', '/me/export'),
    requestDeletion: (reauth: Reauth) => request<{ status: 'scheduled'; deleteOn: string }>('POST', '/me/delete', { ...reauth, confirm: 'DELETE' }),
    cancelDeletion: () => request<{ status: 'kept' }>('POST', '/me/delete/cancel'),
  },
  members: {
    list: (workspaceId: string) => request<{ members: MemberRow[]; invites: InviteRow[] }>('GET', `/workspaces/${workspaceId}/members`),
    invite: (workspaceId: string, email: string, role: GrantableRole) => request<InviteRow>('POST', `/workspaces/${workspaceId}/members/invites`, { email, role }),
    cancelInvite: (workspaceId: string, inviteId: string) => request<{ status: 'cancelled' }>('DELETE', `/workspaces/${workspaceId}/members/invites/${inviteId}`),
    accept: (token: string) => request<{ status: 'joined'; workspace: { id: string; name: string; type: string }; role: string } | { status: 'invalid_token' } | { status: 'wrong_account'; invitedEmail: string | null }>('POST', '/workspaces/invites/accept', { token }),
    setRole: (workspaceId: string, userId: string, role: GrantableRole) => request<{ userId: string; role: string }>('PATCH', `/workspaces/${workspaceId}/members/${userId}`, { role }),
    remove: (workspaceId: string, userId: string) => request<{ status: 'removed' }>('DELETE', `/workspaces/${workspaceId}/members/${userId}`),
    transfer: (workspaceId: string, userId: string) => request<{ status: 'transferred'; ownerId: string }>('POST', `/workspaces/${workspaceId}/members/transfer`, { userId }),
  },
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
    rename: (id: string, name: string) => request<{ id: string; name: string }>('PATCH', `/workspaces/${id}`, { name }),
    remove: (id: string, confirmName: string) => request<{ id: string; deleted: true }>('DELETE', `/workspaces/${id}`, { confirmName }),
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
    editText: (workspaceId: string, id: string, field: string, value: string) =>
      request<GenerationRow>('PATCH', `/workspaces/${workspaceId}/generations/${id}/text`, { field, value }),
    /** Same-origin, so the session cookie rides along with EventSource. */
    streamUrl: (workspaceId: string, id: string) => `${BASE}/workspaces/${workspaceId}/generations/${id}/stream`,
  },
  brand: {
    get: (workspaceId: string) => request<BrandKitRow>('GET', `/workspaces/${workspaceId}/brand`),
    patch: (workspaceId: string, patch: Partial<BrandKitRow>) => request<BrandKitRow>('PATCH', `/workspaces/${workspaceId}/brand`, patch),
  },
  wallet: {
    summary: (workspaceId: string) =>
      request<WalletSummary>('GET', `/workspaces/${workspaceId}/wallet`),
    history: (workspaceId: string, cursor?: string) =>
      request<{ rows: LedgerRow[]; nextCursor: string | null }>(
        'GET', `/workspaces/${workspaceId}/wallet/history${cursor ? `?cursor=${cursor}` : ''}`),
  },
};
