import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderRegistry } from './provider.registry';

describe('ProviderRegistry deployment safeguards', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('refuses a detectable sandbox provider key in production', () => {
    vi.stubEnv('APP_ENV', 'production');
    vi.stubEnv('PHOTOROOM_API_KEY', 'sandbox_watermarked_key');

    expect(() => new ProviderRegistry()).toThrow(/sandbox provider credentials/i);
  });

  it('allows the same sandbox key in an explicit development deployment', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('APP_ENV', 'dev');
    vi.stubEnv('PHOTOROOM_API_KEY', 'sandbox_watermarked_key');

    expect(() => new ProviderRegistry()).not.toThrow();
  });
});
