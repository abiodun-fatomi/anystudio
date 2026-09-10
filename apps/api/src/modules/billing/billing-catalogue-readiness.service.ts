import { Injectable } from '@nestjs/common';
import { PrismaClient, type Prisma } from '@prisma/client';
import { isProductionDeployment } from '../../../config/environment';
import { GatewayRegistry } from './gateways/gateway.registry';

export interface BillingCatalogueReadiness {
  ready: boolean;
  missing: string[];
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

    if (production && !flutterwave) missing.push('Flutterwave is required for the production NGN market');
    if (production && !paddle) missing.push('Paddle is required for the production USD and GBP markets');

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

    return { ready: missing.length === 0, missing };
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
