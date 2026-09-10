import { afterEach, describe, expect, it, vi } from 'vitest';
import { BillingCatalogueReadinessService } from './billing-catalogue-readiness.service';

const plan = (providerRefs: unknown) => ({ code: 'creator', providerRefs });
const pack = (providerRefs: unknown) => ({ code: 'pack.small', providerRefs });

describe('BillingCatalogueReadinessService', () => {
  afterEach(() => vi.unstubAllEnvs());

  function service(input: { flutterwave?: boolean; paddle?: boolean; plans?: unknown[]; packs?: unknown[] } = {}) {
    const db = {
      plan: { findMany: vi.fn().mockResolvedValue(input.plans ?? []) },
      creditPack: { findMany: vi.fn().mockResolvedValue(input.packs ?? []) },
    };
    const gateways = { has: vi.fn((provider: string) => (provider === 'FLUTTERWAVE' ? input.flutterwave : provider === 'PADDLE' ? input.paddle : false)) };
    return new BillingCatalogueReadinessService(db as never, gateways as never);
  }

  it('permits a non-production environment with only the stub', async () => {
    vi.stubEnv('APP_ENV', 'dev');
    await expect(service().check()).resolves.toEqual({ ready: true, missing: [] });
  });

  it('validates every configured real gateway outside production', async () => {
    vi.stubEnv('APP_ENV', 'staging');
    vi.stubEnv('PADDLE_USAGE_PRODUCT_ID', 'wrong');
    const result = await service({
      paddle: true,
      plans: [plan({ paddle: { month: 'pri_month', year: 'bad' } })],
      packs: [pack({ paddle: { once: 'bad' } })],
    }).check();
    expect(result.ready).toBe(false);
    expect(result.missing).toEqual([
      'Plan creator needs a Paddle pri_ year reference',
      'Credit pack pack.small needs a Paddle pri_ once reference',
      'PADDLE_USAGE_PRODUCT_ID must be a Paddle pro_ identifier',
    ]);
  });

  it('requires both launch gateways and complete active catalogue references in production', async () => {
    vi.stubEnv('APP_ENV', 'production');
    const result = await service({ flutterwave: true, plans: [plan({ flutterwave: { month: 123, year: '456' } })] }).check();
    expect(result.ready).toBe(false);
    expect(result.missing).toContain('Paddle is required for the production USD and GBP markets');
    expect(result.missing).not.toContain('Plan creator needs a numeric Flutterwave month reference');
  });

  // The launch state: live site, no gateway approvals yet. Before this, /ready
  // answered "degraded" forever and every release went red on the smoke test.
  it('is ready in production when payments are declared off and no gateway is configured', async () => {
    vi.stubEnv('APP_ENV', 'production');
    vi.stubEnv('PAYMENTS_DISABLED', 'true');
    const result = await service({ plans: [plan({ flutterwave: { month: 123, year: '456' } })] }).check();
    expect(result).toEqual({ ready: true, missing: [], paymentsDisabled: true });
  });

  // The declaration excuses an ABSENT gateway, never a broken one. Half a
  // gateway is the state that takes someone's money and cannot deliver.
  it('still fails production when a gateway IS configured but its catalogue is incomplete', async () => {
    vi.stubEnv('APP_ENV', 'production');
    vi.stubEnv('PAYMENTS_DISABLED', 'true');
    const result = await service({ flutterwave: true, plans: [plan({ flutterwave: { month: 'nope', year: '456' } })] }).check();
    expect(result.ready).toBe(false);
    expect(result.paymentsDisabled).toBeUndefined();
    expect(result.missing).toContain('Plan creator needs a numeric Flutterwave month reference');
    expect(result.missing).toContain('Paddle is required for the production USD and GBP markets');
  });

  it('ignores the declaration outside production, where the stub already serves', async () => {
    vi.stubEnv('APP_ENV', 'staging');
    vi.stubEnv('PAYMENTS_DISABLED', 'true');
    await expect(service().check()).resolves.toEqual({ ready: true, missing: [] });
  });

  it('treats anything but the exact word true as not declared', async () => {
    vi.stubEnv('APP_ENV', 'production');
    vi.stubEnv('PAYMENTS_DISABLED', '1');
    const result = await service().check();
    expect(result.ready).toBe(false);
    expect(result.missing).toContain('Flutterwave is required for the production NGN market');
  });

  it('accepts complete production catalogue identifiers without contacting vendors', async () => {
    vi.stubEnv('APP_ENV', 'production');
    vi.stubEnv('PADDLE_USAGE_PRODUCT_ID', 'pro_usage123');
    const result = await service({
      flutterwave: true,
      paddle: true,
      plans: [plan({ flutterwave: { month: 123, year: '456' }, paddle: { month: 'pri_month123', year: 'pri_year456' } })],
      packs: [pack({ paddle: { once: 'pri_pack123' } })],
    }).check();
    expect(result).toEqual({ ready: true, missing: [] });
  });
});
