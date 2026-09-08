import { describe, expect, it, vi } from 'vitest';
import { RetentionService } from './retention.service';

const days = (n: number) => new Date(Date.now() - n * 24 * 60 * 60_000);

function harness() {
  const calls: Record<string, unknown[]> = {};
  const rec =
    (name: string, ret: unknown = { count: 0 }) =>
    (...args: unknown[]) => {
      (calls[name] ??= []).push(args[0]);
      return Promise.resolve(ret);
    };
  const db = {
    $transaction: (ops: unknown[]) => Promise.all(ops),
    user: { findMany: rec('user.findMany', [{ id: 'u1', email: 'a@b.c', phone: null }]), update: rec('user.update', {}) },
    workspaceMember: {
      findMany: rec('member.findMany', [
        { workspaceId: 'solo', workspace: { deletedAt: null, _count: { members: 1 } } },
        { workspaceId: 'shared', workspace: { deletedAt: null, _count: { members: 3 } } },
      ]),
      deleteMany: rec('member.deleteMany'),
    },
    workspace: { updateMany: rec('workspace.updateMany', { count: 1 }) },
    identity: { deleteMany: rec('identity.deleteMany') },
    mfaFactor: { deleteMany: rec('mfa.deleteMany') },
    recoveryCode: { deleteMany: rec('recovery.deleteMany') },
    session: { updateMany: rec('session.updateMany') },
    whatsappContact: { deleteMany: rec('wa.deleteMany') },
    notification: { deleteMany: rec('notification.deleteMany') },
    onboardingState: { deleteMany: rec('onboarding.deleteMany') },
    authEvent: { updateMany: rec('authEvent.updateMany'), create: rec('authEvent.create', {}), deleteMany: rec('authEvent.deleteMany', { count: 7 }) },
    mediaAsset: {
      findMany: rec('media.findMany', [
        { id: 'm1', key: 'k1' },
        { id: 'm2', key: 'k2' },
      ]),
      update: rec('media.update', {}),
    },
    jobApplication: { findMany: rec('apps.findMany', [{ id: 'a1', cvKey: 'cv1' }]), delete: rec('apps.delete', {}) },
    supportConversation: { deleteMany: rec('support.deleteMany', { count: 2 }) },
  };
  const media = { deleteObject: vi.fn(async (key: string) => key !== 'k2') };
  const svc = new RetentionService(db as never, media as never);
  return { svc, calls, media };
}

describe('RetentionService', () => {
  it('anonymises a due account, keeps the tombstone, and takes solo workspaces with it', async () => {
    const { svc, calls } = harness();
    const r = await svc.purgeAccounts();
    expect(r).toEqual({ accounts: 1, workspaces: 1 });
    const q = calls['user.findMany']![0] as { where: { deleteRequestedAt: { lte: Date } } };
    expect(q.where.deleteRequestedAt.lte.getTime()).toBeLessThanOrEqual(days(30).getTime() + 1000);
    const upd = calls['user.update']![0] as { data: Record<string, unknown> };
    expect(upd.data).toMatchObject({ email: null, phone: null, name: null, passwordHash: null, status: 'DELETED' });
    expect(upd.data.deletedAt).toBeInstanceOf(Date);
    expect(calls['workspace.updateMany']![0]).toMatchObject({ where: { id: { in: ['solo'] } } });
    expect(calls['member.deleteMany']![0]).toMatchObject({ where: { userId: 'u1', workspaceId: { notIn: ['solo'] } } });
    expect(calls['authEvent.updateMany']![0]).toMatchObject({ data: { ip: null, userAgent: null } });
  });

  it('purges storage objects and leaves the row alone when storage refuses', async () => {
    const { svc, calls, media } = harness();
    expect(await svc.purgeObjects()).toBe(1);
    expect(media.deleteObject).toHaveBeenCalledTimes(2);
    expect(calls['media.update']).toHaveLength(1);
    expect(calls['media.update']![0]).toMatchObject({ where: { id: 'm1' }, data: { status: 'PURGED' } });
    const query = calls['media.findMany']![0] as { where: { OR: Array<Record<string, unknown>> } };
    expect(query.where.OR).toContainEqual({ kind: 'DERIVED', deletedAt: { not: null }, key: { contains: '/work/' } });
  });

  it('prunes events, applications (with the CV) and closed support conversations on their clocks', async () => {
    const { svc, calls, media } = harness();
    const r = await svc.run();
    expect(r).toMatchObject({ events: 7, applications: 1, support: 2 });
    expect(media.deleteObject).toHaveBeenCalledWith('cv1');
    const ev = calls['authEvent.deleteMany']![0] as { where: { createdAt: { lt: Date } } };
    expect(ev.where.createdAt.lt.getTime()).toBeLessThanOrEqual(days(365).getTime() + 1000);
    const sup = calls['support.deleteMany']![0] as { where: { closedAt: { lt: Date } } };
    expect(sup.where.closedAt.lt.getTime()).toBeLessThanOrEqual(days(730).getTime() + 1000);
  });

  it('keeps going when one step fails', async () => {
    const { svc } = harness();
    vi.spyOn(svc, 'purgeAccounts').mockRejectedValue(new Error('db away'));
    const r = await svc.run();
    expect(r.accounts).toBe(0);
    expect(r.events).toBe(7);
  });
});
