import { beforeEach, describe, expect, it, vi } from 'vitest';

const sentry = vi.hoisted(() => ({
  init: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  flush: vi.fn(async () => true),
  withScope: vi.fn((fn: (scope: unknown) => void) => fn({ setTags: vi.fn(), setUser: vi.fn(), setTag: vi.fn() })),
}));
vi.mock('@sentry/node', () => sentry);

describe('sentry bridge', () => {
  beforeEach(() => {
    vi.resetModules();
    sentry.init.mockClear();
    sentry.captureException.mockClear();
  });

  it('does nothing without a DSN', async () => {
    delete process.env.SENTRY_DSN;
    const m = await import('./sentry');
    expect(m.initSentry('api')).toBe(false);
    m.captureFromLog({ err: new Error('x') }, 'boom');
    expect(sentry.init).not.toHaveBeenCalled();
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it('forwards error-level lines with their context once configured', async () => {
    process.env.SENTRY_DSN = 'https://k@o.ingest.sentry.io/1';
    const m = await import('./sentry');
    expect(m.initSentry('worker')).toBe(true);
    expect(sentry.init).toHaveBeenCalledWith(expect.objectContaining({ tracesSampleRate: 0, sendDefaultPii: false, serverName: 'worker' }));
    const err = new Error('db away');
    m.captureFromLog({ err, requestId: 'r1', userId: 'u1', body: { secret: 1 } }, 'request failed');
    expect(sentry.captureException).toHaveBeenCalledWith(err);
    delete process.env.SENTRY_DSN;
  });

  it('the logger hook reaches the bridge for error lines only', async () => {
    process.env.SENTRY_DSN = 'https://k@o.ingest.sentry.io/1';
    const m = await import('./sentry');
    m.initSentry('api');
    const { logger } = await import('./index');
    logger.info({ err: new Error('quiet') }, 'not an error');
    expect(sentry.captureException).not.toHaveBeenCalled();
    const loud = new Error('loud');
    logger.error({ err: loud }, 'request failed');
    expect(sentry.captureException).toHaveBeenCalledWith(loud);
    delete process.env.SENTRY_DSN;
  });
});
