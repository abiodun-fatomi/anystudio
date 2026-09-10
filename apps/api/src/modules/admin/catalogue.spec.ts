/**
 * What the console may do to a plan or a pack, and what it must refuse.
 *
 * The refusals matter more than the successes here. A bad value saved from
 * this screen does not fail at this screen — it fails at a customer's
 * checkout, in a market nobody on the team buys in, or it keeps `/ready`
 * degraded with nothing to say which of four rows is at fault. So the
 * validation is checked against the SAME predicates
 * BillingCatalogueReadinessService uses to decide whether production can sell.
 */
import { describe, expect, it, vi } from 'vitest';
import { AdminService } from './admin.service';
import { ValidationError } from '../../../config/globals/errors';

const req = { ip: '1.2.3.4', requestId: 'test', get: () => undefined } as never;

/** ADMIN rank with a second factor confirmed a minute ago. */
const actor = {
  userId: 'staff_1',
  surface: 'ADMIN',
  staffRole: 'SUPERADMIN',
  mfaLevel: 2,
  lastStepUpAt: new Date(Date.now() - 60_000),
  impersonating: false,
  workspaceRoles: new Map(),
} as never;

function harness(row: Record<string, unknown> | null = { code: 'creator' }) {
  const update = vi.fn(async ({ data }: { data: unknown }) => ({ code: 'creator', ...(data as object) }));
  const db = {
    plan: { findUnique: vi.fn().mockResolvedValue(row), update, findMany: vi.fn().mockResolvedValue([]) },
    creditPack: { findUnique: vi.fn().mockResolvedValue(row), update, findMany: vi.fn().mockResolvedValue([]) },
  };
  const service = new AdminService(db as never, {} as never, {} as never, {} as never, {} as never, {} as never);
  return { service, update };
}

const reason = 'Paddle products created';

describe('the catalogue screen', () => {
  it('saves a full set of market prices', async () => {
    const { service, update } = harness();
    await service.patchPlan(actor, 'creator', { reason, priceByMarket: { USD: 9, NGN: 12000, GBP: 7 } } as never, req);
    expect(update.mock.calls[0]![0].data).toEqual({ priceByMarket: { USD: 9, NGN: 12000, GBP: 7 } });
  });

  // A market with no price throws at checkout for customers in that market and
  // nobody else — the worst possible place to discover a typo.
  it('refuses a price that leaves a market out', async () => {
    const { service, update } = harness();
    await expect(service.patchPlan(actor, 'creator', { reason, priceByMarket: { USD: 9, GBP: 7 } } as never, req)).rejects.toBeInstanceOf(ValidationError);
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses a negative price and a market we do not sell in', async () => {
    const { service } = harness();
    await expect(service.patchPlan(actor, 'creator', { reason, priceByMarket: { USD: -1, NGN: 1, GBP: 1 } } as never, req)).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(service.patchPlan(actor, 'creator', { reason, priceByMarket: { USD: 9, NGN: 1, GBP: 1, EUR: 8 } } as never, req)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('accepts gateway ids in the shape the readiness check demands', async () => {
    const { service, update } = harness();
    await service.patchPlan(
      actor,
      'creator',
      { reason, providerRefs: { paddle: { month: ' pri_01abc ', year: 'pri_01def' }, flutterwave: { month: 12345, year: '12346' } } } as never,
      req,
    );
    // Trimmed on the way in, so a pasted id with a stray space still matches.
    expect(update.mock.calls[0]![0].data).toEqual({
      providerRefs: { paddle: { month: 'pri_01abc', year: 'pri_01def' }, flutterwave: { month: 12345, year: '12346' } },
    });
  });

  it('refuses a malformed gateway id rather than storing one production will reject', async () => {
    const { service } = harness();
    await expect(service.patchPlan(actor, 'creator', { reason, providerRefs: { paddle: { month: 'pro_01abc' } } } as never, req)).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(service.patchPlan(actor, 'creator', { reason, providerRefs: { flutterwave: { month: 'abc' } } } as never, req)).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(service.patchPlan(actor, 'creator', { reason, providerRefs: { stripe: { month: 'x' } } } as never, req)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('clears the yearly price when sent null, so a plan can go monthly-only', async () => {
    const { service, update } = harness();
    await service.patchPlan(actor, 'creator', { reason, yearlyPriceByMarket: null } as never, req);
    expect(update.mock.calls[0]![0].data).toHaveProperty('yearlyPriceByMarket');
  });

  it('has no yearly price on a pack', async () => {
    const { service, update } = harness();
    await service.patchPack(actor, 'pack.small', { reason, yearlyPriceByMarket: { USD: 1, NGN: 1, GBP: 1 }, active: false } as never, req);
    expect(update.mock.calls[0]![0].data).toEqual({ active: false });
  });

  it('refuses an empty patch instead of writing an audit line about nothing', async () => {
    const { service } = harness();
    await expect(service.patchPack(actor, 'pack.small', { reason } as never, req)).rejects.toBeInstanceOf(ValidationError);
  });

  it('refuses a row that does not exist', async () => {
    const { service } = harness(null);
    await expect(service.patchPlan(actor, 'nope', { reason, active: true } as never, req)).rejects.toThrow();
  });

  // The rank and step-up rules are the same ones patchPrice has used all along.
  it('refuses a staff member below ADMIN', async () => {
    const { service, update } = harness();
    const support = { ...(actor as object), staffRole: 'SUPPORT' } as never;
    await expect(service.patchPlan(support, 'creator', { reason, active: false } as never, req)).rejects.toThrow();
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses a stale second factor', async () => {
    const { service } = harness();
    const stale = { ...(actor as object), lastStepUpAt: new Date(Date.now() - 60 * 60_000) } as never;
    await expect(service.patchPlan(stale, 'creator', { reason, active: false } as never, req)).rejects.toThrow();
  });
});
