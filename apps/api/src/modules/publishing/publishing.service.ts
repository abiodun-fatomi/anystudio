/**
 * Publishing: connected accounts, the posts that go out through them, and
 * the share sheet for the channels that need no account at all.
 *
 * THE DATABASE IS THE QUEUE
 * -------------------------
 * A post is a row with a time. The worker asks every few seconds for rows
 * that are due and claims each with a conditional update (SCHEDULED →
 * PUBLISHING); the claim is what stops two ticks, or two workers, posting
 * the same thing twice. No Redis anywhere in this path, so a Redis outage
 * cannot lose a scheduled post, and a worker that dies mid-post leaves a
 * PUBLISHING row that the same sweep reclaims once it has sat too long.
 *
 * RETRIES ARE SMALL AND FINITE
 * ----------------------------
 * A platform that says "not now" (rate limit, processing timeout, 5xx) is
 * tried again in two minutes, then ten, then given up on with a sentence
 * the customer can act on. A platform that says "never" (bad file, dead
 * token) is not retried at all. A dead token also marks the ACCOUNT as
 * needing re-authorisation, so the next post through it is refused up
 * front instead of failing in the queue.
 *
 * TOKENS ARE SECRETS
 * ------------------
 * Encrypted under APP_KEY at rest, decrypted only in the moment they are
 * used, never returned by any endpoint, never logged.
 */
import { Injectable } from '@nestjs/common';
import { PrismaClient, type Prisma, type PublishJob, type SocialAccount, type SocialPlatform } from '@prisma/client';
import type { Request, Response } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../../config/globals/errors';
import { logger } from '../../../config/logger';
import { decrypt, encrypt } from '../../utils/crypto/encrypt';
import { AuthService } from '../auth/auth.service';
import type { Actor } from '../auth/policy';
import { MediaService } from '../media/media.service';
import { NotificationService } from '../notification/notification.service';
import { InstagramConnector } from './connectors/instagram.connector';
import { TikTokConnector } from './connectors/tiktok.connector';
import { PublishError, type Connector, type TokenSet } from './connectors/types';
import type { ConnectCallbackQueryDto, PublishCreateDto, PublishListQueryDto, PublishPatchDto } from './publishing.dto';

export const CONNECT_COOKIE = '__Host-as_connect';
export const CONNECT_COOKIE_OPTS = { httpOnly: true, secure: true, sameSite: 'lax' as const, path: '/', maxAge: 10 * 60_000 };
const STATE_TTL_MS = 10 * 60_000;
/** Attempts and the gap before each retry. Index 0 is the first try. */
const RETRY_GAPS_MS = [0, 2 * 60_000, 10 * 60_000];
/** A PUBLISHING row older than this was abandoned by a worker that died. */
const STUCK_AFTER_MS = 20 * 60_000;
/** How many due posts one tick will take on. */
const BATCH = 5;
/** Refresh a token this long before it expires. */
const REFRESH_AHEAD_MS = 7 * 86_400_000;
/** The signed URL a platform fetches media from must outlive its processing. */
const MEDIA_URL_TTL_SEC = 60 * 60;

const b64url = (b: Buffer): string => b.toString('base64url');
const safeNext = (v: unknown): string => (typeof v === 'string' && v.startsWith('/') && !v.startsWith('//') ? v : '/publishing');

interface ConnectState {
  /** CSRF token, echoed by the platform as `state`. */
  s: string;
  /** PKCE verifier (TikTok). */
  v: string;
  platform: SocialPlatform;
  workspaceId: string;
  userId: string;
  /** The app origin that started this, so the callback returns there. */
  origin: string;
  next: string;
  t: number;
}

export interface AccountView {
  id: string;
  platform: SocialPlatform;
  handle: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  status: SocialAccount['status'];
  tokenExpiresAt: string | null;
  connectedAt: string;
  formats: string[];
}

export interface PlatformView {
  platform: SocialPlatform;
  /** False when this environment has no app credentials; the UI says so instead of offering a button that 500s. */
  available: boolean;
  formats: string[];
}

@Injectable()
export class PublishingService {
  private readonly connectors: Record<SocialPlatform, Connector> = { INSTAGRAM: new InstagramConnector(), TIKTOK: new TikTokConnector() };
  private running = false;

  constructor(
    private readonly db: PrismaClient,
    private readonly auth: AuthService,
    private readonly media: MediaService,
    private readonly notifications: NotificationService,
  ) {}

  // ------------------------------------------------------------ platforms

  platforms(): PlatformView[] {
    return (Object.keys(this.connectors) as SocialPlatform[]).map((p) => ({
      platform: p,
      available: this.connectors[p].configured(),
      formats: this.connectors[p].formats(),
    }));
  }

  /** The callback is one URL per environment, registered with each platform; the workspace rides in the state. */
  callbackUri(origin: string, platform: SocialPlatform): string {
    return `${origin}/api/v1/publishing/callback/${platform.toLowerCase()}`;
  }

  // ------------------------------------------------------------- accounts

  async accounts(workspaceId: string): Promise<AccountView[]> {
    const rows = await this.db.socialAccount.findMany({ where: { workspaceId, status: { not: 'DISCONNECTED' } }, orderBy: { createdAt: 'asc' } });
    return rows.map((r) => this.accountView(r));
  }

  private accountView(r: SocialAccount): AccountView {
    return {
      id: r.id,
      platform: r.platform,
      handle: r.handle,
      displayName: r.displayName,
      avatarUrl: r.avatarUrl,
      status: r.status,
      tokenExpiresAt: r.tokenExpiresAt?.toISOString() ?? null,
      connectedAt: r.createdAt.toISOString(),
      formats: this.connectors[r.platform].formats(),
    };
  }

  /**
   * Begin connecting: a redirect to the platform's consent screen and a
   * cookie that remembers who asked, for which workspace, and where to go
   * back to. The cookie is encrypted, so none of that can be edited in
   * flight, and it dies in ten minutes.
   */
  connectStart(actor: Actor, workspaceId: string, platform: SocialPlatform, next: string | undefined, req: Request, res: Response): void {
    const connector = this.connectors[platform];
    const origin = this.auth.publicOrigin(req);
    if (!connector.configured()) {
      logger.warn({ platform, workspaceId }, 'publishing: connect refused — platform app credentials not set in this environment');
      res.redirect(302, `${origin}${safeNext(next)}?error=not_configured&platform=${platform.toLowerCase()}`);
      return;
    }
    const state: ConnectState = {
      s: b64url(randomBytes(24)),
      v: b64url(randomBytes(32)),
      platform,
      workspaceId,
      userId: actor.userId,
      origin,
      next: safeNext(next),
      t: Date.now(),
    };
    const challenge = b64url(createHash('sha256').update(state.v).digest());
    const url = connector.authorizeUrl(this.callbackUri(origin, platform), state.s, { challenge });
    res.cookie(CONNECT_COOKIE, encrypt(JSON.stringify(state)), CONNECT_COOKIE_OPTS);
    logger.info({ platform, workspaceId, userId: actor.userId }, 'publishing: connect started');
    res.redirect(302, url);
  }

  /**
   * The platform sends the browser back here. Every failure ends on the
   * publishing page with a short code rather than an error page — someone
   * who pressed Cancel on the consent screen did nothing wrong.
   */
  async connectCallback(platform: SocialPlatform, q: ConnectCallbackQueryDto, req: Request, res: Response): Promise<void> {
    const raw = req.cookies?.[CONNECT_COOKIE] as string | undefined;
    res.clearCookie(CONNECT_COOKIE, { ...CONNECT_COOKIE_OPTS, maxAge: undefined });
    let state: ConnectState | null = null;
    try {
      state = raw ? (JSON.parse(decrypt(raw)) as ConnectState) : null;
    } catch {
      state = null;
    }
    const fallbackOrigin = this.auth.publicOrigin(req);
    const back = (code: string, extra: Record<string, string> = {}) => {
      const q2 = new URLSearchParams({ [code === 'connected' ? 'connected' : 'error']: code === 'connected' ? platform.toLowerCase() : code, ...extra });
      res.redirect(302, `${state?.origin ?? fallbackOrigin}${state?.next ?? '/publishing'}?${q2.toString()}`);
    };

    if (!state || Date.now() - state.t > STATE_TTL_MS || state.platform !== platform) return back('expired');
    if (q.error) {
      logger.info({ platform, error: q.error, reason: q.error_reason }, 'publishing: consent declined or failed');
      return back(q.error === 'access_denied' ? 'declined' : 'failed');
    }
    if (!q.code || !q.state || q.state !== state.s) return back('state');

    const connector = this.connectors[platform];
    try {
      const { tokens, accounts } = await connector.exchange(q.code, this.callbackUri(state.origin, platform), { verifier: state.v });
      if (accounts.length === 0) {
        logger.warn({ platform, workspaceId: state.workspaceId }, 'publishing: consent given but no postable account found');
        return back('no_account');
      }
      for (const a of accounts) {
        // Instagram posts with the Page's token; TikTok with the user's.
        const accessToken = a.pageToken ?? tokens.accessToken;
        await this.db.socialAccount.upsert({
          where: { workspaceId_platform_externalId: { workspaceId: state.workspaceId, platform, externalId: a.externalId } },
          create: {
            workspaceId: state.workspaceId,
            platform,
            externalId: a.externalId,
            handle: a.handle,
            displayName: a.displayName,
            avatarUrl: a.avatarUrl,
            pageId: a.pageId ?? null,
            accessToken: encrypt(accessToken),
            refreshToken: tokens.refreshToken ? encrypt(tokens.refreshToken) : null,
            tokenExpiresAt: tokens.expiresAt,
            scopes: tokens.scopes,
            status: 'CONNECTED',
            connectedById: state.userId,
          },
          update: {
            handle: a.handle,
            displayName: a.displayName,
            avatarUrl: a.avatarUrl,
            pageId: a.pageId ?? null,
            accessToken: encrypt(accessToken),
            refreshToken: tokens.refreshToken ? encrypt(tokens.refreshToken) : null,
            tokenExpiresAt: tokens.expiresAt,
            scopes: tokens.scopes,
            status: 'CONNECTED',
            lastError: null,
            disconnectedAt: null,
            connectedById: state.userId,
          },
        });
      }
      logger.info({ platform, workspaceId: state.workspaceId, accounts: accounts.length }, 'publishing: account connected');
      return back('connected', { count: String(accounts.length) });
    } catch (err) {
      logger.error({ platform, workspaceId: state.workspaceId, err: err instanceof Error ? err.message : String(err) }, 'publishing: connect exchange failed');
      return back('failed');
    }
  }

  async disconnect(workspaceId: string, accountId: string): Promise<void> {
    const row = await this.db.socialAccount.findFirst({ where: { id: accountId, workspaceId } });
    if (!row) throw new NotFoundError('account');
    await this.db.$transaction([
      this.db.socialAccount.update({
        where: { id: row.id },
        data: { status: 'DISCONNECTED', disconnectedAt: new Date(), accessToken: '', refreshToken: null },
      }),
      // Anything still waiting to go out through it can no longer.
      this.db.publishJob.updateMany({
        where: { accountId: row.id, status: 'SCHEDULED' },
        data: { status: 'CANCELLED', failureReason: 'The account was disconnected before this went out.' },
      }),
    ]);
    logger.info({ platform: row.platform, workspaceId, accountId }, 'publishing: account disconnected');
  }

  // ----------------------------------------------------------------- jobs

  async create(actor: Actor, workspaceId: string, dto: PublishCreateDto): Promise<PublishJob[]> {
    if (dto.accountIds.length === 0) throw new ValidationError({ accountIds: 'Pick at least one account.' });
    const accounts = await this.db.socialAccount.findMany({ where: { id: { in: dto.accountIds }, workspaceId } });
    if (accounts.length !== new Set(dto.accountIds).size) throw new NotFoundError('account');
    for (const a of accounts) {
      if (a.status !== 'CONNECTED') throw new ConflictError(`${a.handle ?? a.platform} needs to be connected again before it can post.`);
      if (!this.connectors[a.platform].formats().includes(dto.format))
        throw new ValidationError({ format: `${a.platform === 'INSTAGRAM' ? 'Instagram' : 'TikTok'} does not take a ${dto.format.toLowerCase()} post.` });
    }
    const asset = await this.db.mediaAsset.findFirst({ where: { key: dto.mediaKey, workspaceId, deletedAt: null } });
    if (!asset) throw new NotFoundError('file');
    if (dto.generationId) {
      const g = await this.db.generation.findFirst({ where: { id: dto.generationId, workspaceId }, select: { id: true } });
      if (!g) throw new NotFoundError('generation');
    }
    const when = dto.scheduledFor ? new Date(dto.scheduledFor) : new Date();
    if (Number.isNaN(when.getTime())) throw new ValidationError({ scheduledFor: 'That is not a time.' });
    if (when.getTime() > Date.now() + 90 * 86_400_000) throw new ValidationError({ scheduledFor: 'Posts can be scheduled up to 90 days ahead.' });
    const scheduledFor = when.getTime() < Date.now() ? new Date() : when;

    const rows = await this.db.$transaction(
      accounts.map((a) =>
        this.db.publishJob.create({
          data: {
            workspaceId,
            accountId: a.id,
            generationId: dto.generationId ?? null,
            createdById: actor.userId,
            platform: a.platform,
            format: dto.format,
            mediaKey: dto.mediaKey,
            mediaMime: asset.mime,
            caption: dto.caption,
            scheduledFor,
            nextAttemptAt: scheduledFor,
          },
        }),
      ),
    );
    logger.info({ workspaceId, userId: actor.userId, jobs: rows.map((r) => r.id), scheduledFor, format: dto.format }, 'publishing: jobs created');
    return rows;
  }

  async list(
    workspaceId: string,
    q: PublishListQueryDto,
  ): Promise<{ rows: Array<PublishJob & { account: AccountView; mediaUrl: string | null }>; nextCursor: string | null }> {
    const take = q.take ?? 50;
    const upcoming = (q.view ?? 'upcoming') === 'upcoming';
    const rows = await this.db.publishJob.findMany({
      where: { workspaceId, status: upcoming ? { in: ['SCHEDULED', 'PUBLISHING'] } : { in: ['PUBLISHED', 'FAILED', 'CANCELLED'] } },
      orderBy: upcoming ? { scheduledFor: 'asc' } : { updatedAt: 'desc' },
      take: take + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      include: { account: true },
    });
    const page = rows.slice(0, take);
    const urls = await this.media.readUrls(workspaceId, [...new Set(page.map((r) => r.mediaKey))]).catch(() => ({}) as Record<string, string>);
    return {
      rows: page.map((r) => ({ ...r, account: this.accountView(r.account), mediaUrl: urls[r.mediaKey] ?? null })),
      nextCursor: rows.length > take ? page[page.length - 1]!.id : null,
    };
  }

  async patch(workspaceId: string, id: string, dto: PublishPatchDto): Promise<PublishJob> {
    const row = await this.db.publishJob.findFirst({ where: { id, workspaceId } });
    if (!row) throw new NotFoundError('post');
    if (row.status !== 'SCHEDULED') throw new ConflictError('Only a post that has not gone out yet can be changed.');
    const data: { caption?: string; scheduledFor?: Date; nextAttemptAt?: Date } = {};
    if (dto.caption !== undefined) data.caption = dto.caption;
    if (dto.scheduledFor !== undefined) {
      const when = new Date(dto.scheduledFor);
      if (Number.isNaN(when.getTime())) throw new ValidationError({ scheduledFor: 'That is not a time.' });
      data.scheduledFor = when.getTime() < Date.now() ? new Date() : when;
      data.nextAttemptAt = data.scheduledFor;
    }
    return this.db.publishJob.update({ where: { id: row.id }, data });
  }

  async cancel(workspaceId: string, id: string): Promise<PublishJob> {
    const r = await this.db.publishJob.updateMany({ where: { id, workspaceId, status: 'SCHEDULED' }, data: { status: 'CANCELLED' } });
    if (r.count === 0) {
      const row = await this.db.publishJob.findFirst({ where: { id, workspaceId } });
      if (!row) throw new NotFoundError('post');
      throw new ConflictError('That post has already gone out, or is going out now.');
    }
    return this.db.publishJob.findUniqueOrThrow({ where: { id } });
  }

  /** A failed post, tried again from the start — the person has usually fixed something (reconnected, trimmed the caption). */
  async retry(workspaceId: string, id: string): Promise<PublishJob> {
    const row = await this.db.publishJob.findFirst({ where: { id, workspaceId }, include: { account: true } });
    if (!row) throw new NotFoundError('post');
    if (row.status !== 'FAILED') throw new ConflictError('Only a failed post can be tried again.');
    if (row.account.status !== 'CONNECTED') throw new ConflictError('Connect the account again first.');
    return this.db.publishJob.update({
      where: { id: row.id },
      data: { status: 'SCHEDULED', attempts: 0, nextAttemptAt: new Date(), scheduledFor: new Date(), lastError: null, failureReason: null },
    });
  }

  /** The share sheet: a link to the file that lives an hour, for WhatsApp Status and any native share. */
  async share(workspaceId: string, mediaKey: string): Promise<{ url: string; mime: string | null; expiresInSec: number }> {
    const asset = await this.db.mediaAsset.findFirst({ where: { key: mediaKey, workspaceId, deletedAt: null }, select: { mime: true } });
    if (!asset) throw new NotFoundError('file');
    return { url: await this.media.signRead(mediaKey, MEDIA_URL_TTL_SEC), mime: asset.mime, expiresInSec: MEDIA_URL_TTL_SEC };
  }

  // --------------------------------------------------------------- worker

  /**
   * One tick: claim what is due, post it, record what happened. Never
   * overlaps itself; a slow platform makes the next tick wait, not double up.
   */
  async runDue(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let done = 0;
    try {
      // A worker that died mid-post leaves PUBLISHING behind; hand those back to the queue.
      const stuck = await this.db.publishJob.updateMany({
        where: { status: 'PUBLISHING', updatedAt: { lt: new Date(Date.now() - STUCK_AFTER_MS) } },
        data: { status: 'SCHEDULED', nextAttemptAt: new Date() },
      });
      if (stuck.count) logger.warn({ count: stuck.count }, 'publishing: reclaimed posts abandoned mid-publish');

      const due = await this.db.publishJob.findMany({
        where: { status: 'SCHEDULED', nextAttemptAt: { lte: new Date() } },
        orderBy: { nextAttemptAt: 'asc' },
        take: BATCH,
        select: { id: true },
      });
      for (const { id } of due) {
        // The claim: only one tick wins this row.
        const claimed = await this.db.publishJob.updateMany({ where: { id, status: 'SCHEDULED' }, data: { status: 'PUBLISHING', attempts: { increment: 1 } } });
        if (claimed.count === 0) continue;
        await this.attempt(id);
        done++;
      }
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'publishing: tick failed');
    } finally {
      this.running = false;
    }
    return done;
  }

  private async attempt(id: string): Promise<void> {
    const job = await this.db.publishJob.findUniqueOrThrow({ where: { id }, include: { account: true } });
    const log = Array.isArray(job.log) ? (job.log as Prisma.InputJsonValue[]) : [];
    const entry: Record<string, Prisma.InputJsonValue> = { at: new Date().toISOString(), attempt: job.attempts };
    const connector = this.connectors[job.platform];
    const { account } = job;
    try {
      if (account.status !== 'CONNECTED')
        throw new PublishError('account not connected', true, false, `${account.handle ?? 'The account'} needs to be connected again.`);
      if (!connector.configured())
        throw new PublishError('platform not configured in this environment', false, false, 'Posting to this platform is not switched on yet.');
      const url = await this.media.signRead(job.mediaKey, MEDIA_URL_TTL_SEC);
      const outcome = await connector.publish(
        { externalId: account.externalId, accessToken: decrypt(account.accessToken), pageId: account.pageId },
        {
          format: job.format,
          mediaUrl: url,
          mime: job.mediaMime ?? 'application/octet-stream',
          caption: job.caption,
          bytes: () => this.media.getBytes(job.mediaKey),
        },
      );
      Object.assign(entry, { ok: true, externalPostId: outcome.externalPostId });
      await this.db.publishJob.update({
        where: { id },
        data: {
          status: 'PUBLISHED',
          publishedAt: new Date(),
          externalPostId: outcome.externalPostId,
          externalUrl: outcome.externalUrl,
          lastError: null,
          failureReason: null,
          log: [...log, entry],
        },
      });
      logger.info(
        { jobId: id, platform: job.platform, workspaceId: job.workspaceId, attempt: job.attempts, externalPostId: outcome.externalPostId },
        'publishing: posted',
      );
      await this.notifications.notify(job.createdById, {
        workspaceId: job.workspaceId,
        kind: 'PUBLISH',
        title: `Posted to ${job.platform === 'INSTAGRAM' ? 'Instagram' : 'TikTok'}`,
        body: account.handle ? `@${account.handle}` : null,
        href: outcome.externalUrl ?? '/publishing?view=history',
        refId: `publish:${id}:ok`,
      });
    } catch (err) {
      const e = err instanceof PublishError ? err : new PublishError(err instanceof Error ? err.message : String(err), false);
      const canRetry = !e.permanent && job.attempts < RETRY_GAPS_MS.length;
      Object.assign(entry, { ok: false, error: e.message, permanent: e.permanent });
      const customer = e.customer ?? (canRetry ? null : 'The platform did not accept the post. Try again, or post it by hand from the share sheet.');
      await this.db.publishJob.update({
        where: { id },
        data: canRetry
          ? {
              status: 'SCHEDULED',
              nextAttemptAt: new Date(Date.now() + (RETRY_GAPS_MS[job.attempts] ?? 10 * 60_000)),
              lastError: e.message,
              log: [...log, entry],
            }
          : { status: 'FAILED', lastError: e.message, failureReason: customer, log: [...log, entry] },
      });
      if (e.reauth) {
        await this.db.socialAccount.update({ where: { id: account.id }, data: { status: 'NEEDS_REAUTH', lastError: e.message } });
      }
      const level = canRetry ? 'warn' : 'error';
      logger[level](
        { jobId: id, platform: job.platform, workspaceId: job.workspaceId, attempt: job.attempts, retry: canRetry, reauth: e.reauth, err: e.message },
        canRetry ? 'publishing: attempt failed, will retry' : 'publishing: post failed',
      );
      if (!canRetry) {
        await this.notifications.notify(job.createdById, {
          workspaceId: job.workspaceId,
          kind: 'PUBLISH',
          title: `Could not post to ${job.platform === 'INSTAGRAM' ? 'Instagram' : 'TikTok'}`,
          body: customer,
          href: '/publishing?view=history',
          refId: `publish:${id}:failed`,
        });
      }
    }
  }

  /** Keep tokens alive: anything expiring within a week is exchanged for a fresh one. Once a day is plenty. */
  async refreshTokens(): Promise<number> {
    const soon = await this.db.socialAccount.findMany({
      where: { status: 'CONNECTED', tokenExpiresAt: { lte: new Date(Date.now() + REFRESH_AHEAD_MS) } },
      take: 50,
    });
    let refreshed = 0;
    for (const a of soon) {
      const connector = this.connectors[a.platform];
      if (!connector.configured()) continue;
      try {
        const current: TokenSet = {
          accessToken: decrypt(a.accessToken),
          refreshToken: a.refreshToken ? decrypt(a.refreshToken) : null,
          expiresAt: a.tokenExpiresAt,
          scopes: a.scopes,
        };
        const fresh = await connector.refresh(current);
        await this.db.socialAccount.update({
          where: { id: a.id },
          data: {
            accessToken: encrypt(fresh.accessToken),
            refreshToken: fresh.refreshToken ? encrypt(fresh.refreshToken) : a.refreshToken,
            tokenExpiresAt: fresh.expiresAt,
            lastError: null,
          },
        });
        refreshed++;
      } catch (err) {
        const e = err instanceof PublishError ? err : null;
        logger.warn(
          { accountId: a.id, platform: a.platform, err: err instanceof Error ? err.message : String(err), reauth: e?.reauth },
          'publishing: token refresh failed',
        );
        if (e?.reauth || (a.tokenExpiresAt && a.tokenExpiresAt < new Date())) {
          await this.db.socialAccount.update({
            where: { id: a.id },
            data: { status: 'NEEDS_REAUTH', lastError: err instanceof Error ? err.message : String(err) },
          });
        }
      }
    }
    if (refreshed) logger.info({ refreshed }, 'publishing: tokens refreshed');
    return refreshed;
  }

  /** Guard for the controller: a member of the workspace, or nothing. */
  assertMember(actor: Actor, workspaceId: string): void {
    if (!actor.workspaceRoles.has(workspaceId)) throw new ForbiddenError();
  }
}
