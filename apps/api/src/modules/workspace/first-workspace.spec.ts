/**
 * A person's FIRST workspace, whichever door it comes through.
 *
 * There are three: `registration.service.ts` (email), the WhatsApp
 * onboarding, and — since Google sign-in stopped leaving people without one —
 * `POST /workspaces` from the welcome screen. The first two both create a
 * PERSONAL studio, take the region from the person's country, and grant
 * SIGNUP_PROMO_CREDITS. The third did none of that, so a Google user arrived
 * with a BUSINESS workspace, Nigerian routing whatever they had confirmed,
 * and no credits to spend.
 *
 * These tests pin the rule where it now lives, so the next door added does
 * not have to remember it.
 */
import { describe, expect, it, vi } from 'vitest';
import { SIGNUP_PROMO_CREDITS } from '@anystudio/shared';
import { ValidationError } from '../../../config/globals/errors';
import { WorkspaceService } from './workspace.service';

const req = { ip: '102.89.0.1', headers: {}, get: () => undefined } as never;

function harness(opts: { seed?: { currency: string; region: string } | null } = {}) {
  const grant = vi.fn().mockResolvedValue(undefined);
  const created: Record<string, unknown>[] = [];
  const tx = {
    workspace: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { id: 'ws_1', type: data.type, name: data.name, currency: data.currency, region: data.region, wallet: { id: 'wal_1' } };
      }),
    },
  };
  const db = {
    workspaceMember: {
      count: vi.fn().mockResolvedValue(opts.seed ? 1 : 0),
      findFirst: vi.fn().mockResolvedValue(opts.seed ? { workspace: opts.seed } : null),
    },
    $transaction: vi.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
  };
  const service = new WorkspaceService(db as never, {} as never, { grant } as never);
  return { service, grant, created, tx };
}

describe('the first workspace on an account', () => {
  it('is PERSONAL, takes its region from the confirmed country, and carries the welcome credits', async () => {
    const { service, grant, created } = harness();
    await service.create('user_1', { name: "Ada's studio", type: 'PERSONAL', billingCountry: 'ke' } as never, req);

    // Kenya bills in USD — KES is not one of the market currencies — but the
    // REGION is still `ke`, which is the part that used to default to `ng`.
    expect(created[0]).toMatchObject({ type: 'PERSONAL', currency: 'USD', region: 'ke', profile: { billingCountry: 'KE' } });
    expect(grant).toHaveBeenCalledOnce();
    expect(grant.mock.calls[0][0]).toMatchObject({ walletId: 'wal_1', amount: SIGNUP_PROMO_CREDITS, reason: 'Welcome credits' });
  });

  // The same 150 credits, keyed on the workspace, so a double-submitted
  // welcome screen cannot mint a second grant.
  it('keys the grant on the workspace so a retry cannot mint twice', async () => {
    const { service, grant } = harness();
    await service.create('user_1', { name: 'Studio', type: 'PERSONAL', billingCountry: 'ng' } as never, req);
    expect(grant.mock.calls[0][0].idempotencyKey).toContain('ws_1');
  });

  it('gives a SECOND workspace no credits and inherits the first one’s region', async () => {
    const { service, grant, created } = harness({ seed: { currency: 'NGN', region: 'ng' } });
    await service.create('user_1', { name: 'Acme Commerce', type: 'BUSINESS' } as never, req);

    expect(created[0]).toMatchObject({ type: 'BUSINESS', currency: 'NGN', region: 'ng' });
    expect(grant).not.toHaveBeenCalled();
  });

  it('refuses a PERSONAL workspace for someone who already has one', async () => {
    const { service } = harness({ seed: { currency: 'NGN', region: 'ng' } });
    // ValidationError renders one generic sentence to the caller, so assert
    // the type rather than wording that is deliberately not specific.
    await expect(service.create('user_1', { name: 'Second studio', type: 'PERSONAL' } as never, req)).rejects.toBeInstanceOf(ValidationError);
  });
});
