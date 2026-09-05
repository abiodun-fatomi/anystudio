/**
 * Instagram, through the Facebook Graph API.
 *
 * Instagram only lets an app post on behalf of a PROFESSIONAL account
 * (Business or Creator) that is linked to a Facebook Page, and only through
 * Facebook Login. So the consent screen is Facebook's, the token that posts
 * is the Page's, and "which Instagram account" is found by walking
 * /me/accounts → page.instagram_business_account. Personal Instagram
 * accounts cannot be posted to by any app; the UI says so.
 *
 * Posting is two calls: create a media container from a public URL, then
 * publish the container. Video containers (reels, stories) are processed
 * asynchronously and must be polled until FINISHED before publishing. The
 * URL we give is a signed R2 URL that lives long enough for Meta to fetch it.
 *
 * Tokens: the short-lived token from login is exchanged for a long-lived one
 * (60 days). A long-lived token can be exchanged again for a fresh one, which
 * is what the refresher does a week before expiry.
 *
 * Needs META_APP_ID and META_APP_SECRET. Until Meta's app review grants
 * instagram_content_publish to the app, only accounts with a role on the
 * app (its developers and testers) can post — which is enough for dev.
 */
import type { PublishFormat } from '@prisma/client';
import { PublishError, type Connector, type PublishInput, type PublishOutcome, type RemoteAccount, type TokenSet } from './types';

const GRAPH = 'https://graph.facebook.com/v21.0';
const SCOPES = ['instagram_basic', 'instagram_content_publish', 'pages_show_list', 'pages_read_engagement', 'business_management'];
const CONTAINER_POLL_MS = 5_000;
const CONTAINER_TIMEOUT_MS = 8 * 60_000;

type GraphError = { error?: { message?: string; code?: number; error_subcode?: number; type?: string } };

async function graph<T>(path: string, init: RequestInit & { token?: string; query?: Record<string, string> } = {}): Promise<T> {
  const url = new URL(`${GRAPH}${path}`);
  for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v);
  if (init.token) url.searchParams.set('access_token', init.token);
  const res = await fetch(url, { method: init.method ?? 'GET', headers: init.headers, body: init.body, signal: AbortSignal.timeout(30_000) });
  const json = (await res.json().catch(() => ({}))) as T & GraphError;
  if (!res.ok || json.error) {
    const e = json.error ?? {};
    const msg = `graph ${path}: ${e.message ?? res.status} (code ${e.code ?? '?'}${e.error_subcode ? `/${e.error_subcode}` : ''})`;
    // 190 = invalid/expired token; 10/200-299 = permission; 4/17/32/613 = rate limits (retry); 2 = transient.
    const code = e.code ?? 0;
    const reauth = code === 190 || code === 102;
    const permanent = reauth || code === 10 || (code >= 200 && code <= 299) || code === 100 || code === 9007;
    throw new PublishError(msg, permanent, reauth, reauth ? 'Instagram needs to be connected again.' : undefined);
  }
  return json;
}

export class InstagramConnector implements Connector {
  readonly platform = 'INSTAGRAM' as const;

  configured(): boolean {
    return Boolean(process.env.META_APP_ID && process.env.META_APP_SECRET);
  }

  formats(): PublishFormat[] {
    return ['IMAGE', 'REEL', 'STORY'];
  }

  authorizeUrl(redirectUri: string, state: string): string {
    const u = new URL('https://www.facebook.com/v21.0/dialog/oauth');
    u.searchParams.set('client_id', process.env.META_APP_ID!);
    u.searchParams.set('redirect_uri', redirectUri);
    u.searchParams.set('state', state);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', SCOPES.join(','));
    return u.toString();
  }

  async exchange(code: string, redirectUri: string): Promise<{ tokens: TokenSet; accounts: RemoteAccount[] }> {
    const short = await graph<{ access_token: string }>('/oauth/access_token', {
      query: { client_id: process.env.META_APP_ID!, client_secret: process.env.META_APP_SECRET!, redirect_uri: redirectUri, code },
    });
    const long = await graph<{ access_token: string; expires_in?: number }>('/oauth/access_token', {
      query: {
        grant_type: 'fb_exchange_token',
        client_id: process.env.META_APP_ID!,
        client_secret: process.env.META_APP_SECRET!,
        fb_exchange_token: short.access_token,
      },
    });
    const tokens: TokenSet = {
      accessToken: long.access_token,
      refreshToken: null,
      expiresAt: long.expires_in ? new Date(Date.now() + long.expires_in * 1000) : new Date(Date.now() + 60 * 86_400_000),
      scopes: SCOPES,
    };
    const pages = await graph<{
      data: Array<{
        id: string;
        name: string;
        access_token: string;
        instagram_business_account?: { id: string; username?: string; name?: string; profile_picture_url?: string };
      }>;
    }>('/me/accounts', {
      token: tokens.accessToken,
      query: { fields: 'id,name,access_token,instagram_business_account{id,username,name,profile_picture_url}' },
    });
    const accounts: RemoteAccount[] = pages.data
      .filter((p) => p.instagram_business_account)
      .map((p) => ({
        externalId: p.instagram_business_account!.id,
        handle: p.instagram_business_account!.username ?? null,
        displayName: p.instagram_business_account!.name ?? p.name,
        avatarUrl: p.instagram_business_account!.profile_picture_url ?? null,
        pageId: p.id,
        pageToken: p.access_token,
      }));
    return { tokens, accounts };
  }

  async refresh(tokens: TokenSet): Promise<TokenSet> {
    const long = await graph<{ access_token: string; expires_in?: number }>('/oauth/access_token', {
      query: {
        grant_type: 'fb_exchange_token',
        client_id: process.env.META_APP_ID!,
        client_secret: process.env.META_APP_SECRET!,
        fb_exchange_token: tokens.accessToken,
      },
    });
    return {
      ...tokens,
      accessToken: long.access_token,
      expiresAt: long.expires_in ? new Date(Date.now() + long.expires_in * 1000) : new Date(Date.now() + 60 * 86_400_000),
    };
  }

  async publish(account: { externalId: string; accessToken: string }, input: PublishInput): Promise<PublishOutcome> {
    const ig = account.externalId;
    const token = account.accessToken;
    const isVideo = input.mime.startsWith('video/');
    if (input.format === 'IMAGE' && isVideo)
      throw new PublishError('a feed image post needs an image file', true, false, 'Pick an image for a feed post, or post it as a reel.');
    if (input.format === 'REEL' && !isVideo)
      throw new PublishError('a reel needs a video file', true, false, 'A reel needs a video. Post an image to the feed or as a story instead.');

    const body: Record<string, string> = { caption: input.caption.slice(0, 2200) };
    if (input.format === 'IMAGE') body.image_url = input.mediaUrl;
    if (input.format === 'REEL') Object.assign(body, { media_type: 'REELS', video_url: input.mediaUrl, share_to_feed: 'true' });
    if (input.format === 'STORY') Object.assign(body, { media_type: 'STORIES', ...(isVideo ? { video_url: input.mediaUrl } : { image_url: input.mediaUrl }) });

    const container = await graph<{ id: string }>(`/${ig}/media`, { method: 'POST', token, query: body });

    // Video is processed before it can be published; images are ready at once.
    if (isVideo) {
      const started = Date.now();
      for (;;) {
        const s = await graph<{ status_code?: string; status?: string }>(`/${container.id}`, { token, query: { fields: 'status_code,status' } });
        if (s.status_code === 'FINISHED') break;
        if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED')
          throw new PublishError(
            `container ${s.status_code}: ${s.status ?? ''}`,
            true,
            false,
            'Instagram could not process that video. Try a shorter or smaller file.',
          );
        if (Date.now() - started > CONTAINER_TIMEOUT_MS) throw new PublishError('container did not finish processing in time', false);
        await new Promise((r) => setTimeout(r, CONTAINER_POLL_MS));
      }
    }

    const published = await graph<{ id: string }>(`/${ig}/media_publish`, { method: 'POST', token, query: { creation_id: container.id } });
    let permalink: string | null = null;
    try {
      permalink = (await graph<{ permalink?: string }>(`/${published.id}`, { token, query: { fields: 'permalink' } })).permalink ?? null;
    } catch {
      /* the post is up; the link is a nicety */
    }
    return { externalPostId: published.id, externalUrl: permalink };
  }
}
