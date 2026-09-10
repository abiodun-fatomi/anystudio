import { afterEach, describe, expect, it, vi } from 'vitest';
import { GatewayRegistry, PaymentsUnavailableError } from './gateway.registry';

function productionPaddle(apiKey: string, clientToken: string) {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('APP_ENV', 'production');
  vi.stubEnv('FLUTTERWAVE_SECRET_KEY', '');
  vi.stubEnv('FLUTTERWAVE_WEBHOOK_SECRET', '');
  vi.stubEnv('PADDLE_ENV', 'live');
  vi.stubEnv('PADDLE_API_KEY', apiKey);
  vi.stubEnv('PADDLE_CLIENT_TOKEN', clientToken);
  vi.stubEnv('PADDLE_WEBHOOK_SECRET', 'pdl_ntfset_live_endpoint_secret');
  vi.stubEnv('PADDLE_PRODUCT_APPROVED', 'true');
}

describe('GatewayRegistry production fail-closed behavior', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('does not enable the free stub when NODE_ENV is production and APP_ENV was omitted', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('APP_ENV', '');
    vi.stubEnv('FLUTTERWAVE_SECRET_KEY', '');
    vi.stubEnv('FLUTTERWAVE_WEBHOOK_SECRET', '');
    vi.stubEnv('PADDLE_API_KEY', '');
    vi.stubEnv('PADDLE_CLIENT_TOKEN', '');
    vi.stubEnv('PADDLE_WEBHOOK_SECRET', '');

    const registry = new GatewayRegistry();

    expect(registry.get('STUB')).toBeNull();
    expect(() => registry.forCurrency('NGN')).toThrow(PaymentsUnavailableError);
  });

  it('allows the non-production stub when explicit APP_ENV=dev overrides NODE_ENV=production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('APP_ENV', ' dev ');
    vi.stubEnv('FLUTTERWAVE_SECRET_KEY', '');
    vi.stubEnv('FLUTTERWAVE_WEBHOOK_SECRET', '');
    vi.stubEnv('PADDLE_API_KEY', '');
    vi.stubEnv('PADDLE_CLIENT_TOKEN', '');
    vi.stubEnv('PADDLE_WEBHOOK_SECRET', '');

    const registry = new GatewayRegistry();

    expect(registry.get('STUB')).not.toBeNull();
    expect(registry.forCurrency('NGN').provider).toBe('STUB');
  });

  it('rejects a Flutterwave sandbox secret in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('APP_ENV', 'production');
    vi.stubEnv('FLUTTERWAVE_SECRET_KEY', 'FLWSECK_TEST-do-not-charge');
    vi.stubEnv('FLUTTERWAVE_WEBHOOK_SECRET', 'configured-secret-hash');

    expect(() => new GatewayRegistry()).toThrow('A Flutterwave test secret key cannot be used in production');
  });

  it('rejects a Paddle sandbox API key even when PADDLE_ENV says live', () => {
    productionPaddle('pdl_sdbx_apikey_not-a-real-key', 'live_not-a-real-token');

    expect(() => new GatewayRegistry()).toThrow('A Paddle sandbox API key cannot be used in production');
  });

  it('rejects a Paddle sandbox client-side token even when PADDLE_ENV says live', () => {
    productionPaddle('pdl_live_apikey_not-a-real-key', 'test_not-a-real-token');

    expect(() => new GatewayRegistry()).toThrow('A Paddle live client-side token is required in production');
  });

  it('rejects live Paddle credentials until the exact AnyStudio product is approved', () => {
    productionPaddle('pdl_live_apikey_not-a-real-key', 'live_not-a-real-token');
    vi.stubEnv('PADDLE_PRODUCT_APPROVED', 'false');

    expect(() => new GatewayRegistry()).toThrow('PADDLE_PRODUCT_APPROVED must be "true"');
  });
});
