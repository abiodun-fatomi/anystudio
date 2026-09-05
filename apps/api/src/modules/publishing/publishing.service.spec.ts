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
      findMany: vi.fn(async () => jobs.filter((j) => j.status === 'SCHEDULED' && (j.nextAttemptAt ?? new Date(0)) <= new Date()).map((j) => ({ id: j.id }))),
      findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => ({ ...jobs.find((j) => j.id === where.id)!, account })),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const j = jobs.find((x) => x.id === where.id)!;
        Object.assign(j, data);
        return j;
      }),
    },
    socialAccount: { update: vi.fn(async (args: unknown) => accountUpdates.push(args)) },
  };
  const media = { signRead: vi.fn(async () => 'https://signed/k'), getBytes: vi.fn(async () => Buffer.from('x')) };
  const notifications = { notify: vi.fn(async () => undefined) };
  const svc = new PublishingService(db as never, {} as never, media as never, notifications as never);
  const publish = vi.fn();
  (svc as unknown as { connectors: Record<string, unknown> }).connectors.INSTAGRAM = { configured: () => true, publish, formats: () => ['IMAGE'] };
  return { svc, jobs, publish, notifications, accountUpdates, db };
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
});
