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
import { isProductionDeployment } from '../../../../config/environment';
import type { Gateway } from '../billing.types';
import { providerForCurrency } from '../billing.types';
import { FlutterwaveGateway } from './flutterwave.gateway';
import { PaddleGateway } from './paddle.gateway';
import { StubGateway } from './stub.gateway';

export class PaymentsUnavailableError extends AppError {
  constructor(currency: string) {
    super('payments_unavailable', 503, `Payments in ${currency} are not available yet. Contact support and we will sort it out by hand.`);
  }
}

@Injectable()
export class GatewayRegistry {
  private readonly gateways = new Map<PaymentProvider, Gateway>();
  private readonly isProd: boolean;

  constructor() {
    const env = process.env;
    this.isProd = isProductionDeployment(env);
    const flutterwave = [env.FLUTTERWAVE_SECRET_KEY, env.FLUTTERWAVE_WEBHOOK_SECRET];
    if (flutterwave.some(Boolean) && !flutterwave.every(Boolean)) {
      const message = 'Flutterwave is only partly configured; both FLUTTERWAVE_SECRET_KEY and FLUTTERWAVE_WEBHOOK_SECRET are required';
      if (this.isProd) throw new Error(message);
      logger.warn(message);
    } else if (env.FLUTTERWAVE_SECRET_KEY && env.FLUTTERWAVE_WEBHOOK_SECRET) {
      if (this.isProd && env.FLUTTERWAVE_SECRET_KEY.startsWith('FLWSECK_TEST-')) {
        throw new Error('A Flutterwave test secret key cannot be used in production');
      }
      this.gateways.set('FLUTTERWAVE', new FlutterwaveGateway(env.FLUTTERWAVE_SECRET_KEY, env.FLUTTERWAVE_WEBHOOK_SECRET));
    }
    const paddle = [env.PADDLE_API_KEY, env.PADDLE_CLIENT_TOKEN, env.PADDLE_WEBHOOK_SECRET];
    if (paddle.some(Boolean) && !paddle.every(Boolean)) {
      const message = 'Paddle is only partly configured; PADDLE_API_KEY, PADDLE_CLIENT_TOKEN and PADDLE_WEBHOOK_SECRET are all required';
      if (this.isProd) throw new Error(message);
      logger.warn(message);
    } else if (env.PADDLE_API_KEY && env.PADDLE_CLIENT_TOKEN && env.PADDLE_WEBHOOK_SECRET) {
      const paddleEnv = env.PADDLE_ENV === 'live' ? 'live' : 'sandbox';
      if (this.isProd && paddleEnv !== 'live') throw new Error('PADDLE_ENV must be "live" in production');
      if (this.isProd && env.PADDLE_API_KEY.startsWith('pdl_sdbx_apikey_')) {
        throw new Error('A Paddle sandbox API key cannot be used in production');
      }
      if (this.isProd && !env.PADDLE_CLIENT_TOKEN.startsWith('live_')) {
        throw new Error('A Paddle live client-side token is required in production');
      }
      if (this.isProd && env.PADDLE_PRODUCT_APPROVED !== 'true') {
        throw new Error(
          'PADDLE_PRODUCT_APPROVED must be "true" only after Paddle approves AnyStudio’s exact AI face, voice, video and publishing feature set in writing',
        );
      }
      this.gateways.set('PADDLE', new PaddleGateway(env.PADDLE_API_KEY, env.PADDLE_WEBHOOK_SECRET, paddleEnv));
    }
    if (!this.isProd) this.gateways.set('STUB', new StubGateway(env.BILLING_STUB_SECRET ?? 'stub'));
    logger.info({ gateways: [...this.gateways.keys()], production: this.isProd }, 'payment gateways registered');
  }

  /** The gateway a workspace in this currency pays through. */
  forCurrency(currency: string): Gateway {
    const want = providerForCurrency(currency);
    const g = this.gateways.get(want);
    if (g) return g;
    if (!this.isProd && process.env.BILLING_STUB !== 'false') {
      const stub = this.gateways.get('STUB');
      if (stub) {
        logger.warn({ currency, want }, 'no keys for gateway; using the stub');
        return stub;
      }
    }
    throw new PaymentsUnavailableError(currency);
  }

  get(provider: PaymentProvider): Gateway | null {
    return this.gateways.get(provider) ?? null;
  }

  has(provider: PaymentProvider): boolean {
    return this.gateways.has(provider);
  }
}
