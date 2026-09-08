/**
 * The publish loop: a due row is claimed once, a "not now" is retried with
 * a gap, a "never" fails for good, and a dead token marks the account.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PublishingService } from './publishing.service';
import { PublishError } from './connectors/types';
import { encrypt } from '../../utils/crypto/encrypt';

type Job = Record<string, unknown> & { id: string; status: string; attempts: number; nextAttemptAt: Date | null; log?: unknown[] };

function harness() {
  process.env.APP_KEY = Buffer.alloc(32, 7).toString('base64');
  const account = { id: 'a1', platform: 'INSTAGRAM', externalId: 'ig1', handle: 'bimbo', accessToken: encrypt('tok'), pageId: 'p1', status: 'CONNECTED' };
  const jobs: Job[] = [
    {
      id: 'j1',
      workspaceId: 'w1',
      accountId: 'a1',
      createdById: 'u1',
      platform: 'INSTAGRAM',
      format: 'IMAGE',
      mediaKey: 'k',
      mediaMime: 'image/jpeg',
      caption: 'hi',
      status: 'SCHEDULED',
      attempts: 0,
      nextAttemptAt: new Date(0),
      updatedAt: new Date(),
      log: null,
    },
  ];
  const accountUpdates: unknown[] = [];
  const db = {
    publishJob: {
      updateMany: vi.fn(async ({ where, data }: { where: { id?: string; status: string }; data: Record<string, unknown> }) => {
        const hit = jobs.filter((j) => (!where.id || j.id === where.id) && j.status === where.status);
        for (const j of hit) {
          const { attempts, ...rest } = data;
          Object.assign(j, rest);
          if (attempts && typeof attempts === 'object') j.attempts += (attempts as { increment: number }).increment;
        }
        return { count: hit.length };
      }),
      findMany: vi.fn(async ({ where, include }: { where?: { status?: string }; include?: unknown } = {}) => {
        // The metrics sweep asks for PUBLISHED rows with their account; the due-runner for SCHEDULED ids.
        if (where?.status === 'PUBLISHED') return jobs.filter((j) => j.status === 'PUBLISHED').map((j) => (include ? { ...j, account } : j));
        return jobs.filter((j) => j.status === 'SCHEDULED' && (j.nextAttemptAt ?? new Date(0)) <= new Date()).map((j) => ({ id: j.id }));
      }),
      findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => ({ ...jobs.find((j) => j.id === where.id)!, account })),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const j = jobs.find((x) => x.id === where.id)!;
        Object.assign(j, data);
        return j;
      }),
    },
    socialAccount: {
      findMany: vi.fn(async () => [account]),
      update: vi.fn(async (args: unknown) => accountUpdates.push(args)),
    },
  };
  const media = {
    readUrl: vi.fn(async (_workspaceId: string, key: string) => {
      if (key.includes('/vault/')) throw new Error('vault media is locked');
      return 'https://signed/k';
    }),
    requireReady: vi.fn(async (_workspaceId: string, key: string) => {
      if (key.includes('/vault/')) throw new Error('vault media is locked');
      return { key, mime: 'image/jpeg' };
    }),
    getBytes: vi.fn(async () => Buffer.from('x')),
  };
  const notifications = { notify: vi.fn(async () => undefined) };
  const svc = new PublishingService(db as never, {} as never, media as never, notifications as never);
  const publish = vi.fn();
  const metrics = vi.fn();
  (svc as unknown as { connectors: Record<string, unknown> }).connectors.INSTAGRAM = { configured: () => true, publish, metrics, formats: () => ['IMAGE'] };
  return { svc, jobs, publish, metrics, notifications, accountUpdates, db, media };
}

describe('publishing loop', () => {
  beforeEach(() => vi.useRealTimers());

  it('claims a due post once, posts it, and tells the person', async () => {
    const h = harness();
    h.publish.mockResolvedValueOnce({ externalPostId: '17890', externalUrl: 'https://instagram.com/p/x' });
    expect(await h.svc.runDue()).toBe(1);
    expect(h.jobs[0]!.status).toBe('PUBLISHED');
    expect(h.jobs[0]!.externalPostId).toBe('17890');
    expect(h.jobs[0]!.attempts).toBe(1);
    expect(h.notifications.notify).toHaveBeenCalledWith('u1', expect.objectContaining({ kind: 'PUBLISH', title: 'Posted to Instagram' }));
    // Nothing left to do: the row is not SCHEDULED any more.
    expect(await h.svc.runDue()).toBe(0);
  });

  it('retries a "not now" with a gap, then gives up with a sentence', async () => {
    const h = harness();
    h.publish.mockRejectedValue(new PublishError('graph: rate limited (code 4)', false));
    await h.svc.runDue();
    expect(h.jobs[0]!.status).toBe('SCHEDULED');
    expect(h.jobs[0]!.attempts).toBe(1);
    expect((h.jobs[0]!.nextAttemptAt as Date).getTime()).toBeGreaterThan(Date.now() + 60_000);
    expect(h.notifications.notify).not.toHaveBeenCalled();

    // Pretend the gaps have passed, twice more.
    for (let i = 0; i < 2; i++) {
      h.jobs[0]!.nextAttemptAt = new Date(0);
      await h.svc.runDue();
    }
    expect(h.jobs[0]!.status).toBe('FAILED');
    expect(h.jobs[0]!.attempts).toBe(3);
    expect(h.jobs[0]!.failureReason).toMatch(/did not accept/);
    expect(h.notifications.notify).toHaveBeenCalledWith('u1', expect.objectContaining({ title: 'Could not post to Instagram' }));
  });

  it('a dead token fails at once and marks the account for re-authorisation', async () => {
    const h = harness();
    h.publish.mockRejectedValue(new PublishError('graph: invalid token (code 190)', true, true, 'Instagram needs to be connected again.'));
    await h.svc.runDue();
    expect(h.jobs[0]!.status).toBe('FAILED');
    expect(h.jobs[0]!.failureReason).toBe('Instagram needs to be connected again.');
    expect(h.accountUpdates[0]).toEqual(expect.objectContaining({ data: expect.objectContaining({ status: 'NEEDS_REAUTH' }) }));
  });

  it('the token reaches the connector decrypted and is never on the row in clear', async () => {
    const h = harness();
    h.publish.mockResolvedValueOnce({ externalPostId: '1', externalUrl: null });
    await h.svc.runDue();
    expect(h.publish).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: 'tok', externalId: 'ig1' }),
      expect.objectContaining({ mediaUrl: 'https://signed/k' }),
    );
  });

  it('cannot turn a locked vault asset into a share URL or scheduled post', async () => {
    const h = harness();
    const key = 'w1/vault/2026/09/gen/g1/song.mp3';

    await expect(h.svc.share('w1', key)).rejects.toThrow('vault media is locked');
    await expect(
      h.svc.create({ userId: 'u1' } as never, 'w1', {
        accountIds: ['a1'],
        format: 'IMAGE',
        mediaKey: key,
        caption: 'do not publish',
      } as never),
    ).rejects.toThrow('vault media is locked');
    expect(h.media.readUrl).not.toHaveBeenCalled();
  });

  it('does not publish a legacy queued job whose media key is vaulted', async () => {
    const h = harness();
    h.jobs[0]!.mediaKey = 'w1/vault/2026/09/gen/g1/song.mp3';

    await h.svc.runDue();

    expect(h.publish).not.toHaveBeenCalled();
    expect(h.media.readUrl).toHaveBeenCalledWith('w1', h.jobs[0]!.mediaKey, 60 * 60);
  });
});

describe('how a post is doing', () => {
  const published = (over: Record<string, unknown> = {}) => ({
    status: 'PUBLISHED',
    externalPostId: '17890',
    publishedAt: new Date(Date.now() - 2 * 3600_000),
    metricsAt: null,
    ...over,
  });

  it('reads the numbers off the platform and writes them on the post', async () => {
    const h = harness();
    Object.assign(h.jobs[0]!, published());
    h.metrics.mockResolvedValueOnce({ views: 1200, reach: 900, likes: 41, comments: 6, shares: 2, saved: 8 });
    expect(await h.svc.refreshMetrics()).toBe(1);
    expect(h.jobs[0]!.metrics).toEqual({ views: 1200, reach: 900, likes: 41, comments: 6, shares: 2, saved: 8 });
    expect(h.jobs[0]!.metricsAt).toBeInstanceOf(Date);
    // The token reached the connector decrypted, and only the id it needs.
    expect(h.metrics).toHaveBeenCalledWith({ externalId: 'ig1', accessToken: 'tok' }, '17890');
  });

  it('leaves a fresh post alone, and re-reads an older one', async () => {
    const h = harness();
    Object.assign(h.jobs[0]!, published({ metricsAt: new Date(Date.now() - 5 * 60_000) }));
    expect(await h.svc.refreshMetrics()).toBe(0);
    expect(h.metrics).not.toHaveBeenCalled();

    h.jobs[0]!.metricsAt = new Date(Date.now() - 3 * 3600_000);
    h.metrics.mockResolvedValueOnce({ views: 1, reach: null, likes: 0, comments: 0, shares: null, saved: null });
    expect(await h.svc.refreshMetrics()).toBe(1);
  });

  it('keeps the last numbers when the platform refuses, and marks a dead token', async () => {
    const h = harness();
    Object.assign(h.jobs[0]!, published({ metrics: { views: 10, reach: null, likes: 1, comments: 0, shares: null, saved: null } }));
    h.metrics.mockRejectedValueOnce(new PublishError('graph: invalid token (code 190)', true, true));
    expect(await h.svc.refreshMetrics()).toBe(0);
    expect(h.jobs[0]!.metrics).toEqual({ views: 10, reach: null, likes: 1, comments: 0, shares: null, saved: null });
    // Touched anyway, so one broken post does not hold up the rota.
    expect(h.jobs[0]!.metricsAt).toBeInstanceOf(Date);
    expect(h.accountUpdates[0]).toEqual(expect.objectContaining({ data: expect.objectContaining({ status: 'NEEDS_REAUTH' }) }));
  });
});
