import { Injectable } from '@nestjs/common';
import { PrismaClient, type Prisma } from '@prisma/client';
import { isProductionDeployment } from '../../../config/environment';
import { GatewayRegistry } from './gateways/gateway.registry';

export interface BillingCatalogueReadiness {
  ready: boolean;
  missing: string[];
  /** True when this production deployment is running deliberately without payment gateways. */
  paymentsDisabled?: boolean;
}

/**
 * Is this production deployment running on purpose with no way to take money?
 *
 * A production API with no gateway configured is normally a mistake, and the
 * two checks below exist to catch it. But there is a real state before the
 * gateways are approved — the site is live, people can sign in and generate,
 * organizations run on a credit line — and in that state "no gateway" is the
 * intended configuration, not an incident.
 *
 * Without a way to say so, `/ready` reports `degraded` forever, and
 * scripts/smoke-api.sh requires `ready`: every release goes red at the last
 * step, after the deploy has already happened. A gate that is always red is a
 * gate nobody reads, which costs more than the check was worth.
 *
 * So the state has to be DECLARED. Not inferred from the absence of keys —
 * that is exactly the mistake the checks are for — but written down, in the
 * environment, by a person who meant it. Remove it the day the keys go in;
 * `check()` then fails loudly again if either gateway is missing.
 */
function paymentsDeliberatelyDisabled(): boolean {
  return process.env.PAYMENTS_DISABLED?.trim().toLowerCase() === 'true';
}

/** Local-only launch checks: credentials and catalogue rows, never vendor I/O. */
@Injectable()
export class BillingCatalogueReadinessService {
  constructor(
    private readonly db: PrismaClient,
    private readonly gateways: GatewayRegistry,
  ) {}

  async check(): Promise<BillingCatalogueReadiness> {
    const production = isProductionDeployment();
    const flutterwave = this.gateways.has('FLUTTERWAVE');
    const paddle = this.gateways.has('PADDLE');
    const missing: string[] = [];

    // Declared-off applies ONLY to the "a gateway must exist" pair. Every
    // catalogue check below still runs against whatever IS configured, so a
    // half-configured deployment is never quietly waved through.
    const disabled = production && paymentsDeliberatelyDisabled() && !flutterwave && !paddle;

    if (production && !disabled && !flutterwave) missing.push('Flutterwave is required for the production NGN market');
    if (production && !disabled && !paddle) missing.push('Paddle is required for the production USD and GBP markets');

    const [plans, packs] = await Promise.all([
      this.db.plan.findMany({ where: { active: true }, select: { code: true, providerRefs: true } }),
      this.db.creditPack.findMany({ where: { active: true }, select: { code: true, providerRefs: true } }),
    ]);

    for (const plan of plans) {
      const refs = record(plan.providerRefs);
      if (flutterwave) {
        const gateway = record(refs.flutterwave);
        if (!flutterwaveId(gateway.month)) missing.push(`Plan ${plan.code} needs a numeric Flutterwave month reference`);
        if (!flutterwaveId(gateway.year)) missing.push(`Plan ${plan.code} needs a numeric Flutterwave year reference`);
      }
      if (paddle) {
        const gateway = record(refs.paddle);
        if (!paddleId(gateway.month, 'pri_')) missing.push(`Plan ${plan.code} needs a Paddle pri_ month reference`);
        if (!paddleId(gateway.year, 'pri_')) missing.push(`Plan ${plan.code} needs a Paddle pri_ year reference`);
      }
    }

    if (paddle) {
      for (const pack of packs) {
        const once = record(record(pack.providerRefs).paddle).once;
        if (!paddleId(once, 'pri_')) missing.push(`Credit pack ${pack.code} needs a Paddle pri_ once reference`);
      }
      if (!paddleId(process.env.PADDLE_USAGE_PRODUCT_ID, 'pro_')) missing.push('PADDLE_USAGE_PRODUCT_ID must be a Paddle pro_ identifier');
    }

    return disabled ? { ready: missing.length === 0, missing, paymentsDisabled: true } : { ready: missing.length === 0, missing };
  }
}

function record(value: Prisma.JsonValue | undefined): Record<string, Prisma.JsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, Prisma.JsonValue>) : {};
}

function flutterwaveId(value: unknown): boolean {
  return (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) || (typeof value === 'string' && /^[1-9]\d*$/.test(value.trim()));
}

function paddleId(value: unknown, prefix: 'pri_' | 'pro_'): boolean {
  return typeof value === 'string' && new RegExp(`^${prefix}[A-Za-z0-9]+$`).test(value.trim());
}
