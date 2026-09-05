/**
 * TikTok, through Login Kit and the Content Posting API.
 *
 * Consent is OAuth with PKCE. Tokens are short (24h) with a refresh token
 * that lives a year, so the refresher keeps accounts alive without anyone
 * signing in again. Posting a video is: initialise (tell TikTok the size),
 * PUT the bytes to the upload URL it hands back, then poll the publish
 * status until it is done — pushed, not pulled, because pulling from a URL
 * needs the URL's domain verified in the TikTok app settings and a signed
 * R2 host cannot be. Photo posts go the other way (TikTok only pulls
 * photos), so they need that verification and are refused until it is done.
 *
 * Before an app passes TikTok's review, posts can only be made visible to
 * the account itself (SELF_ONLY): the creator_info call says which privacy
 * levels are allowed and the most open one is used — so in dev the post
 * lands as private, and after review the same code posts publicly.
 *
 * Needs TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET.
 */
import type { PublishFormat } from '@prisma/client';
import { PublishError, type Connector, type PublishInput, type PublishOutcome, type RemoteAccount, type TokenSet } from './types';

const API = 'https://open.tiktokapis.com/v2';
const SCOPES = ['user.info.basic', 'video.publish', 'video.upload'];
const CHUNK = 10 * 1024 * 1024;
const MAX_BYTES = 250 * 1024 * 1024;
const STATUS_POLL_MS = 5_000;
const STATUS_TIMEOUT_MS = 10 * 60_000;
const PRIVACY_ORDER = ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'];

type TikTokEnvelope<T> = { data?: T; error?: { code?: string; message?: string; log_id?: string } };

async function call<T>(path: string, token: string | null, body?: unknown, method = 'POST'): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json; charset=UTF-8', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const json = (await res.json().catch(() => ({}))) as TikTokEnvelope<T>;
  const code = json.error?.code ?? (res.ok ? 'ok' : `http_${res.status}`);
  if (code !== 'ok') {
    const reauth = code === 'access_token_invalid' || code === 'token_expired' || res.status === 401;
    const permanent = reauth || code === 'scope_not_authorized' || code === 'invalid_params' || code === 'unaudited_client_can_only_post_to_private_accounts';
    throw new PublishError(
      `tiktok ${path}: ${code} ${json.error?.message ?? ''} (log ${json.error?.log_id ?? '-'})`,
      permanent,
      reauth,
      reauth ? 'TikTok needs to be connected again.' : undefined,
    );
  }
  return (json.data ?? {}) as T;
}

export class TikTokConnector implements Connector {
  readonly platform = 'TIKTOK' as const;

  configured(): boolean {
    return Boolean(process.env.TIKTOK_CLIENT_KEY && process.env.TIKTOK_CLIENT_SECRET);
  }

  formats(): PublishFormat[] {
    return ['VIDEO'];
  }

  authorizeUrl(redirectUri: string, state: string, pkce?: { challenge: string }): string {
    const u = new URL('https://www.tiktok.com/v2/auth/authorize/');
    u.searchParams.set('client_key', process.env.TIKTOK_CLIENT_KEY!);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', SCOPES.join(','));
    u.searchParams.set('redirect_uri', redirectUri);
    u.searchParams.set('state', state);
    if (pkce) {
      u.searchParams.set('code_challenge', pkce.challenge);
      u.searchParams.set('code_challenge_method', 'S256');
    }
    return u.toString();
  }

  private async token(form: Record<string, string>): Promise<TokenSet & { openId: string }> {
    const res = await fetch(`${API}/oauth/token/`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_key: process.env.TIKTOK_CLIENT_KEY!, client_secret: process.env.TIKTOK_CLIENT_SECRET!, ...form }),
      signal: AbortSignal.timeout(30_000),
    });
    const json = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      open_id?: string;
      scope?: string;
      error?: string;
      error_description?: string;
    };
    if (!res.ok || !json.access_token) {
      const reauth = json.error === 'invalid_grant';
      throw new PublishError(
        `tiktok token: ${json.error ?? res.status} ${json.error_description ?? ''}`,
        true,
        reauth,
        reauth ? 'TikTok needs to be connected again.' : undefined,
      );
    }
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? null,
      expiresAt: new Date(Date.now() + (json.expires_in ?? 86_400) * 1000),
      scopes: (json.scope ?? SCOPES.join(',')).split(','),
      openId: json.open_id ?? '',
    };
  }

  async exchange(code: string, redirectUri: string, pkce?: { verifier: string }): Promise<{ tokens: TokenSet; accounts: RemoteAccount[] }> {
    const t = await this.token({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, ...(pkce ? { code_verifier: pkce.verifier } : {}) });
    const info = await call<{ user?: { open_id?: string; display_name?: string; avatar_url?: string; username?: string } }>(
      '/user/info/?fields=open_id,display_name,avatar_url,username',
      t.accessToken,
      undefined,
      'GET',
    );
    const { openId, ...tokens } = t;
    return {
      tokens,
      accounts: [
        {
          externalId: info.user?.open_id ?? openId,
          handle: info.user?.username ?? null,
          displayName: info.user?.display_name ?? null,
          avatarUrl: info.user?.avatar_url ?? null,
        },
      ],
    };
  }

  async refresh(tokens: TokenSet): Promise<TokenSet> {
    if (!tokens.refreshToken) throw new PublishError('no refresh token', true, true, 'TikTok needs to be connected again.');
    const { openId: _o, ...fresh } = await this.token({ grant_type: 'refresh_token', refresh_token: tokens.refreshToken });
    return fresh;
  }

  async publish(account: { externalId: string; accessToken: string }, input: PublishInput): Promise<PublishOutcome> {
    if (!input.mime.startsWith('video/')) {
      throw new PublishError(
        'tiktok photo posts need a verified pull domain',
        true,
        false,
        'TikTok takes videos from here for now. Post the image to Instagram, or share it to WhatsApp.',
      );
    }
    const token = account.accessToken;

    // What this account may post as, today. Before app review that is SELF_ONLY.
    const creator = await call<{ privacy_level_options?: string[]; max_video_post_duration_sec?: number }>('/post/publish/creator_info/query/', token, {});
    const allowed = creator.privacy_level_options ?? ['SELF_ONLY'];
    const privacy = PRIVACY_ORDER.find((p) => allowed.includes(p)) ?? allowed[0] ?? 'SELF_ONLY';

    const bytes = await input.bytes();
    if (bytes.length > MAX_BYTES) throw new PublishError(`video is ${bytes.length} bytes`, true, false, 'That video is too large for TikTok (250 MB max).');
    const chunkSize = Math.min(CHUNK, bytes.length);
    const totalChunks = Math.max(1, Math.floor(bytes.length / chunkSize));

    const init = await call<{ publish_id: string; upload_url: string }>('/post/publish/video/init/', token, {
      post_info: {
        title: input.caption.slice(0, 2200),
        privacy_level: privacy,
        disable_duet: false,
        disable_comment: false,
        disable_stitch: false,
        video_cover_timestamp_ms: 1000,
      },
      source_info: { source: 'FILE_UPLOAD', video_size: bytes.length, chunk_size: chunkSize, total_chunk_count: totalChunks },
    });

    // The last chunk absorbs the remainder; TikTok wants exactly total_chunk_count PUTs.
    for (let i = 0; i < totalChunks; i++) {
      const start = i * chunkSize;
      const end = i === totalChunks - 1 ? bytes.length : start + chunkSize;
      const res = await fetch(init.upload_url, {
        method: 'PUT',
        headers: {
          'content-type': input.mime,
          'content-length': String(end - start),
          'content-range': `bytes ${start}-${end - 1}/${bytes.length}`,
        },
        body: bytes.subarray(start, end),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok && res.status !== 206) throw new PublishError(`tiktok upload chunk ${i}: http ${res.status}`, false);
    }

    const started = Date.now();
    for (;;) {
      const s = await call<{ status?: string; fail_reason?: string; publicaly_available_post_id?: string[]; publicly_available_post_id?: string[] }>(
        '/post/publish/status/fetch/',
        token,
        { publish_id: init.publish_id },
      );
      if (s.status === 'PUBLISH_COMPLETE') {
        const id = (s.publicly_available_post_id ?? s.publicaly_available_post_id ?? [])[0] ?? init.publish_id;
        return { externalPostId: id, externalUrl: null };
      }
      if (s.status === 'FAILED')
        throw new PublishError(`tiktok publish failed: ${s.fail_reason ?? 'unknown'}`, true, false, 'TikTok did not accept that video.');
      if (Date.now() - started > STATUS_TIMEOUT_MS) throw new PublishError('tiktok publish did not complete in time', false);
      await new Promise((r) => setTimeout(r, STATUS_POLL_MS));
    }
  }
}
