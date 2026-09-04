/**
 * Which gateway serves which currency, given the keys this environment has.
 *
 * Production without a gateway's keys refuses that currency outright — a
 * customer who sees "payments are not available in NGN yet" is better off
 * than one whose card was never charged and whose credits never came. Every
 * other environment falls back to the stub so the flow can be walked end
 * to end without a sandbox account.
 */

import { Injectable } from '@nestjs/common';
import type { PaymentProvider } from '@prisma/client';
import { logger } from '../../../../config/logger';
import { AppError } from '../../../../config/globals/errors';
import type { Gateway } from '../billing.types';
import { providerForCurrency } from '../billing.types';
import { FlutterwaveGateway } from './flutterwave.gateway';
import { PaddleGateway } from './paddle.gateway';
import { StubGateway } from './stub.gateway';

export class PaymentsUnavailableError extends AppError {
  constructor(currency: string) { super('payments_unavailable', 503, `Payments in ${currency} are not available yet. Contact support and we will sort it out by hand.`); }
}

@Injectable()
export class GatewayRegistry {
  private readonly gateways = new Map<PaymentProvider, Gateway>();
  private readonly isProd: boolean;

  constructor() {
    const env = process.env;
    this.isProd = env.APP_ENV === 'production';
    if (env.FLUTTERWAVE_SECRET_KEY) {
      this.gateways.set('FLUTTERWAVE', new FlutterwaveGateway(env.FLUTTERWAVE_SECRET_KEY, env.FLUTTERWAVE_WEBHOOK_SECRET ?? ''));
      if (!env.FLUTTERWAVE_WEBHOOK_SECRET) logger.warn('FLUTTERWAVE_WEBHOOK_SECRET unset: Flutterwave webhooks will be recorded but never trusted');
    }
    if (env.PADDLE_API_KEY) {
      const paddleEnv = env.PADDLE_ENV === 'live' ? 'live' : 'sandbox';
      this.gateways.set('PADDLE', new PaddleGateway(env.PADDLE_API_KEY, env.PADDLE_WEBHOOK_SECRET ?? '', paddleEnv));
      if (!env.PADDLE_WEBHOOK_SECRET) logger.warn('PADDLE_WEBHOOK_SECRET unset: Paddle webhooks will be recorded but never trusted');
      if (this.isProd && paddleEnv !== 'live') logger.error('PADDLE_ENV is not "live" in production: Paddle will take sandbox money');
    }
    if (!this.isProd) this.gateways.set('STUB', new StubGateway(env.BILLING_STUB_SECRET ?? 'stub'));
    logger.info({ gateways: [...this.gateways.keys()], production: this.isProd }, 'payment gateways registered');
  }

  /** The gateway a workspace in this currency pays through. */
  forCurrency(currency: string): Gateway {
    const want = providerForCurrency(currency);
    const g = this.gateways.get(want);
    if (g) return g;
    if (!this.isProd && (process.env.BILLING_STUB !== 'false')) {
      const stub = this.gateways.get('STUB');
      if (stub) { logger.warn({ currency, want }, 'no keys for gateway; using the stub'); return stub; }
    }
    throw new PaymentsUnavailableError(currency);
  }

  get(provider: PaymentProvider): Gateway | null {
    return this.gateways.get(provider) ?? null;
  }

  has(provider: PaymentProvider): boolean { return this.gateways.has(provider); }
}
