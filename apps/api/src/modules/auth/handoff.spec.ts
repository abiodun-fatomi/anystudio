/**
 * The marketing-host hand-off: a sign-in on dev.anystudio.ai ends with a
 * one-time URL on app.dev.anystudio.ai, never a cookie; the app host redeems
 * it exactly once, and only the app host can.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { AuthService } from './auth.service';

type Row = { id: string; purpose: string; tokenHash: string; userId: string; payload: unknown; expiresAt: Date; consumedAt: Date | null };

function harness(origin: string, workspaceTypes: string[] = ['BUSINESS']) {
  const rows: Row[] = [];
  const user = { id: 'u1', status: 'ACTIVE', credentialEpoch: 1 };
  const db = {
    authToken: {
      create: vi.fn(async ({ data }: { data: Omit<Row, 'id' | 'consumedAt'> }) => {
        rows.push({ id: `t${rows.length}`, consumedAt: null, ...data });
      }),
      findUnique: vi.fn(async ({ where }: { where: { tokenHash: string } }) => rows.find((r) => r.tokenHash === where.tokenHash) ?? null),
      updateMany: vi.fn(async ({ where, data }: { where: { id: string; consumedAt: null }; data: { consumedAt: Date } }) => {
        const r = rows.find((x) => x.id === where.id && x.consumedAt === null);
        if (r) r.consumedAt = data.consumedAt;
        return { count: r ? 1 : 0 };
      }),
    },
    user: { findUnique: vi.fn(async () => user) },
    workspaceMember: {
      findFirst: vi.fn(async () => ({ id: 'm', workspace: { type: workspaceTypes[0] ?? 'BUSINESS' } })),
      findMany: vi.fn(async () => workspaceTypes.map((type) => ({ workspace: { type } }))),
    },
  };
  const sessions = { mint: vi.fn(async () => ({ access: 'a', refresh: 'r', accessExpiresAt: new Date(), refreshExpiresAt: new Date() })) };
  const svc = new AuthService(db as never, sessions as never, {} as never, {} as never, {} as never, {} as never, {} as never);
  // setCookies is private and touches express; the test cares that a session was minted, not how it was carried.
  (svc as unknown as { setCookies: () => void }).setCookies = vi.fn();
  const req = { get: (h: string) => (h === 'x-anystudio-origin' ? origin : undefined), ip: '1.1.1.1' } as unknown as Request;
  const res = {} as Response;
  return { svc, db, sessions, rows, req, res, user };
}

describe('sign-in hand-off between hosts', () => {
  beforeEach(() => {
    process.env.APP_ENV = 'dev';
  });
  afterEach(() => {
    delete process.env.APP_ENV;
  });

  it('mints a one-time app-host URL instead of a session when the form was on the marketing host', async () => {
    const h = harness('https://dev.anystudio.ai');
    const finish = (h.svc as unknown as { finishSignIn: AuthService['finishSignIn'] }).finishSignIn.bind(h.svc);
    const r = await finish(h.user as never, 'APP', 1, '/today', h.req, h.res);
    expect(r.status).toBe('handoff');
    if (r.status !== 'handoff') return;
    expect(r.url.startsWith('https://app.dev.anystudio.ai/auth/handoff?token=')).toBe(true);
    expect(h.sessions.mint).not.toHaveBeenCalled();
    expect(h.rows[0].purpose).toBe('SESSION_HANDOFF');
    expect(h.rows[0].payload).toEqual({ mfaLevel: 1, next: '/today' });
    // The raw token is never at rest.
    expect(h.rows[0].tokenHash).not.toContain(new URL(r.url).searchParams.get('token'));
  });

  it('mints the session directly on the app host', async () => {
    const h = harness('https://app.dev.anystudio.ai');
    const finish = (h.svc as unknown as { finishSignIn: AuthService['finishSignIn'] }).finishSignIn.bind(h.svc);
    const r = await finish(h.user as never, 'APP', 1, '/today', h.req, h.res);
    expect(r).toEqual({ status: 'signed_in', next: '/today' });
    expect(h.sessions.mint).toHaveBeenCalledOnce();
  });

  it('redeems the token once, on the app host only, with the MFA level and landing it was minted with', async () => {
    const marketing = harness('https://dev.anystudio.ai');
    const finish = (marketing.svc as unknown as { finishSignIn: AuthService['finishSignIn'] }).finishSignIn.bind(marketing.svc);
    const r = await finish(marketing.user as never, 'APP', 2, '/library', marketing.req, marketing.res);
    const token = r.status === 'handoff' ? new URL(r.url).searchParams.get('token')! : '';

    // Same rows, seen from the app host.
    const app = harness('https://app.dev.anystudio.ai');
    app.rows.push(...marketing.rows);

    // Not from the marketing host itself.
    const wrong = await marketing.svc.completeHandoff({ token }, marketing.req, marketing.res);
    expect(wrong.data).toEqual({ status: 'invalid_token' });

    const ok = await app.svc.completeHandoff({ token }, app.req, app.res);
    expect(ok.data).toEqual({ status: 'signed_in', next: '/library' });
    expect(app.sessions.mint).toHaveBeenCalledWith(expect.objectContaining({ surface: 'APP', mfaLevel: 2 }));

    const again = await app.svc.completeHandoff({ token }, app.req, app.res);
    expect(again.data).toEqual({ status: 'invalid_token' });
    expect(app.sessions.mint).toHaveBeenCalledOnce();
  });

  it('sends someone whose only workspaces are organizations to the org host, and lets that host redeem', async () => {
    const marketing = harness('https://dev.anystudio.ai', ['ORGANIZATION']);
    const finish = (marketing.svc as unknown as { finishSignIn: AuthService['finishSignIn'] }).finishSignIn.bind(marketing.svc);
    const r = await finish(marketing.user as never, 'APP', 1, '/today', marketing.req, marketing.res);
    expect(r.status).toBe('handoff');
    if (r.status !== 'handoff') return;
    expect(r.url.startsWith('https://org.dev.anystudio.ai/auth/handoff?token=')).toBe(true);

    const org = harness('https://org.dev.anystudio.ai', ['ORGANIZATION']);
    org.rows.push(...marketing.rows);
    const ok = await org.svc.completeHandoff({ token: new URL(r.url).searchParams.get('token')! }, org.req, org.res);
    expect(ok.data).toEqual({ status: 'signed_in', next: '/today' });
    expect(org.sessions.mint).toHaveBeenCalledWith(expect.objectContaining({ surface: 'ORG', mfaLevel: 1 }));
  });

  it('someone with a business and an organization starts on app. and hops to org. for the organization', async () => {
    const app = harness('https://app.dev.anystudio.ai', ['ORGANIZATION']);
    const actor = { userId: 'u1', surface: 'APP', mfaLevel: 1 } as never;
    const { url } = await app.svc.hop(actor, { workspaceId: '11111111-1111-4111-8111-111111111111', next: '/library' }, app.req);
    const u = new URL(url);
    expect(u.origin).toBe('https://org.dev.anystudio.ai');
    expect(u.pathname).toBe('/auth/handoff');
    expect(u.searchParams.get('next')).toBe('/library?ws=11111111-1111-4111-8111-111111111111');
    expect(app.rows[0].payload).toEqual({ mfaLevel: 1, next: '/library?ws=11111111-1111-4111-8111-111111111111' });
  });

  it('refuses an expired token', async () => {
    const app = harness('https://app.dev.anystudio.ai');
    app.rows.push({
      id: 't',
      purpose: 'SESSION_HANDOFF',
      tokenHash: createHash('sha256').update('anything').digest('hex'),
      userId: 'u1',
      payload: {},
      expiresAt: new Date(Date.now() - 1),
      consumedAt: null,
    });
    const r = await app.svc.completeHandoff({ token: 'anything' }, app.req, app.res);
    expect(r.data).toEqual({ status: 'invalid_token' });
  });
});
