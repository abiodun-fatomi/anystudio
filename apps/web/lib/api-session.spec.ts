// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { api, SESSION_EXPIRED_EVENT } from './api';

afterEach(() => vi.unstubAllGlobals());
it('notifies the signed-in shell when a protected request reports an expired session', async () => {
  const expired = vi.fn();
  window.addEventListener(SESSION_EXPIRED_EVENT, expired);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 401, ok: false, json: async () => ({ error: 'unauthorized', message: 'Sign in' }) }));
  try {
    await expect(api.wallet.summary('workspace')).rejects.toMatchObject({ status: 401 });
    expect(expired).toHaveBeenCalledTimes(1);
  } finally {
    window.removeEventListener(SESSION_EXPIRED_EVENT, expired);
  }
});
it('does not treat an incorrect login password as an expired signed-in session', async () => {
  const expired = vi.fn();
  window.addEventListener(SESSION_EXPIRED_EVENT, expired);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 401, ok: false, json: async () => ({ error: 'unauthorized' }) }));
  try {
    await expect(api.auth.login('test@example.invalid', 'wrong')).rejects.toMatchObject({ status: 401 });
    expect(expired).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener(SESSION_EXPIRED_EVENT, expired);
  }
});
