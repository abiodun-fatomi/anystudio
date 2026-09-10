// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider, useApp } from './app-context';

const mocks = vi.hoisted(() => ({ path: '/today', me: vi.fn(), wallet: vi.fn() }));
vi.mock('next/navigation', () => ({ usePathname: () => mocks.path }));
vi.mock('./api', () => ({
  api: { auth: { me: mocks.me }, wallet: { summary: mocks.wallet } },
  ApiError: class extends Error {},
  SESSION_EXPIRED_EVENT: 'anystudio:session-expired',
}));

let root: Root;
let container: HTMLDivElement;
let state: ReturnType<typeof useApp>;
const profile = { user: { name: 'Test' }, workspaces: ['a', 'b'].map((id) => ({ id, type: 'PERSONAL', name: id, currency: 'NGN', role: 'OWNER' })) };
function Probe() {
  state = useApp();
  const [draft, setDraft] = useState('empty');
  return (
    <button onClick={() => setDraft('edited')}>
      {state.workspace.id}:{draft}:{state.balance ?? 'loading'}
    </button>
  );
}
const render = async () => {
  await act(async () => {
    root.render(
      <AppProvider>
        <Probe />
      </AppProvider>,
    );
  });
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  mocks.path = '/today';
  mocks.me.mockReset().mockResolvedValue(profile);
  mocks.wallet.mockReset().mockResolvedValue({ balance: 100 });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('workspace navigation loading', () => {
  it('does not refetch auth or reset page state when navigating between sections', async () => {
    await render();
    await act(async () => container.querySelector('button')!.click());
    for (const path of ['/library', '/billing', '/today']) {
      mocks.path = path;
      await render();
    }
    expect(mocks.me).toHaveBeenCalledTimes(1);
    expect(mocks.wallet).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe('a:edited:100');
  });
  it('does not replace a usable page with an error from an unnecessary auth request', async () => {
    await render();
    mocks.me.mockRejectedValue(new Error('offline'));
    mocks.path = '/library';
    await render();
    expect(container.textContent).toBe('a:empty:100');
    expect(mocks.me).toHaveBeenCalledTimes(1);
  });
  it('resets page-local state on workspace switch and ignores the previous wallet response', async () => {
    const a = deferred<{ balance: number }>();
    mocks.wallet.mockImplementation((id: string) => (id === 'a' ? a.promise : Promise.resolve({ balance: 42 })));
    await render();
    await act(async () => container.querySelector('button')!.click());
    await act(async () => state.switchWorkspace('b'));
    expect(container.textContent).toBe('b:empty:42');
    await act(async () => a.resolve({ balance: 999 }));
    expect(container.textContent).toBe('b:empty:42');
  });
  it('does not reset when selecting the already active workspace', async () => {
    await render();
    await act(async () => container.querySelector('button')!.click());
    await act(async () => state.switchWorkspace('a'));
    expect(container.textContent).toBe('a:edited:100');
  });
  it('shows a named loading state until authentication resolves', async () => {
    const response = deferred<typeof profile>();
    mocks.me.mockReturnValue(response.promise);
    await render();
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Loading your workspace');
    await act(async () => response.resolve(profile));
    expect(container.querySelector('[role="status"]')).toBeNull();
  });
  it('provides recovery instead of an endless loading screen after bootstrap failure', async () => {
    mocks.me.mockRejectedValue(new Error('offline'));
    await render();
    expect(container.textContent).toContain('could not reach AnyStudio');
    expect(container.querySelector('button')?.textContent).toBe('Try again');
  });
  it('recovers to another local workspace when a membership refresh removes the active one', async () => {
    await render();
    mocks.me.mockResolvedValue({ ...profile, workspaces: [profile.workspaces[1]] });
    await act(async () => state.refreshMe());
    expect(state.workspace.id).toBe('b');
    expect(container.textContent).toBe('b:empty:100');
  });
});
