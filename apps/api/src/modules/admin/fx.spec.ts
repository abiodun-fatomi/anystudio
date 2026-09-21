import { describe, expect, it, vi } from 'vitest';
import { AdminService } from './admin.service';
import { ValidationError } from '../../../config/globals/errors';

const req = { ip: '1.2.3.4', requestId: 'fx-test', get: () => undefined } as never;
const actor = {
  userId: 'staff_1',
  surface: 'ADMIN',
  staffRole: 'SUPERADMIN',
  mfaLevel: 2,
  lastStepUpAt: new Date(),
  impersonating: false,
  workspaceRoles: new Map(),
} as never;
const reason = 'Update the exchange-rate standard';

function harness() {
  const tx = {
    fxRate: { upsert: vi.fn(async ({ create }) => create) },
    plan: {
      findMany: vi.fn().mockResolvedValue([
        { code: 'creator', priceByMarket: { USD: 9, NGN: 12000, GBP: 7 }, yearlyPriceByMarket: { USD: 90, NGN: 120000, GBP: 70 } },
        { code: 'org', priceByMarket: { USD: 499 }, yearlyPriceByMarket: { USD: 4990 } },
        { code: 'free', priceByMarket: { USD: 0, NGN: 0, GBP: 0 }, yearlyPriceByMarket: null },
        { code: 'legacy', priceByMarket: { NGN: 1500 }, yearlyPriceByMarket: null },
      ]),
      update: vi.fn().mockResolvedValue({}),
    },
    creditPack: {
      findMany: vi.fn().mockResolvedValue([{ code: 'small', priceByMarket: { USD: 6, NGN: 7500, GBP: 5 } }]),
      update: vi.fn().mockResolvedValue({}),
    },
  };
  // Only transaction delegates are available: all pricing writes must share
  // the same database transaction, including the saved rate.
  const db = { $transaction: vi.fn(async (fn) => fn(tx)) };
  const service = new AdminService(db as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
  return { service, tx, db };
}

describe('FX repricing', () => {
  it('rounds monthly, annual, and pack prices to NGN 500 without changing USD or adding markets', async () => {
    const { service, tx, db } = harness();
    const out = await service.setFxRate(actor, { currency: 'ngn', rate: 1450, apply: true, reason }, req);
    expect(out.changed).toEqual([
      { kind: 'plan', code: 'creator', from: 12000, to: 13000, yearlyTo: 130500 },
      { kind: 'pack', code: 'small', from: 7500, to: 8500 },
    ]);
    expect(tx.plan.update).toHaveBeenCalledExactlyOnceWith({
      where: { code: 'creator' },
      data: { priceByMarket: { USD: 9, NGN: 13000, GBP: 7 }, yearlyPriceByMarket: { USD: 90, NGN: 130500, GBP: 70 } },
    });
    expect(tx.creditPack.update).toHaveBeenCalledWith({ where: { code: 'small' }, data: { priceByMarket: { USD: 6, NGN: 8500, GBP: 5 } } });
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'Serializable' });
  });

  it('rounds other currencies to whole units', async () => {
    const { service } = harness();
    const out = await service.setFxRate(actor, { currency: 'GBP', rate: 0.85, apply: true, reason }, req);
    expect(out.changed).toEqual([
      { kind: 'plan', code: 'creator', from: 7, to: 8, yearlyTo: 77 },
      { kind: 'pack', code: 'small', from: 5, to: 5 },
    ]);
  });

  it('can save a standard without changing catalogue prices', async () => {
    const { service, tx } = harness();
    const out = await service.setFxRate(actor, { currency: 'GBP', rate: 0.8, reason }, req);
    expect(out).toEqual({ currency: 'GBP', rate: 0.8, applied: false, changed: [] });
    expect(tx.plan.findMany).not.toHaveBeenCalled();
    expect(tx.creditPack.update).not.toHaveBeenCalled();
  });

  it.each(['USD', 'EUR', '', '???'])('rejects unsupported or anchor currency %s before writing', async (currency) => {
    const { service, db } = harness();
    await expect(service.setFxRate(actor, { currency, rate: 1, apply: true, reason }, req)).rejects.toBeInstanceOf(ValidationError);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it.each([0, -1, Infinity, NaN, 0.00001, 1.23456, 100000000])('rejects unrepresentable rate %s before writing', async (rate) => {
    const { service, db } = harness();
    await expect(service.setFxRate(actor, { currency: 'NGN', rate, apply: true, reason }, req)).rejects.toBeInstanceOf(ValidationError);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('requires superadmin rank and a recent second factor', async () => {
    const { service, db } = harness();
    for (const overrides of [{ staffRole: 'ADMIN' }, { lastStepUpAt: new Date(0) }, { impersonating: true }]) {
      await expect(
        service.setFxRate({ ...(actor as object), ...overrides } as never, { currency: 'NGN', rate: 1450, apply: true, reason }, req),
      ).rejects.toThrow();
    }
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('fails the entire operation when a price cannot be saved', async () => {
    const { service, tx } = harness();
    tx.plan.update.mockRejectedValueOnce(new Error('write failed'));
    await expect(service.setFxRate(actor, { currency: 'NGN', rate: 1450, apply: true, reason }, req)).rejects.toThrow('write failed');
    expect(tx.creditPack.update).not.toHaveBeenCalled();
  });
});
