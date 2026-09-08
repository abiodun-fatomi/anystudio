// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import LibraryPage from './page';
import { ToastProvider } from '@/components/ui';
const mocks = vi.hoisted(() => ({ list: vi.fn(), router: { replace: vi.fn() }, workspace: { id: 'a' } }));
vi.mock('next/navigation', () => ({ useRouter: () => mocks.router, useSearchParams: () => new URLSearchParams() }));
vi.mock('@/lib/app-context', () => ({ useApp: () => ({ workspace: mocks.workspace }) }));
vi.mock('@/lib/api', () => ({ api: { library: { list: mocks.list } } }));

it('shows a retryable load error instead of claiming the library is empty', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  const root = createRoot(container);
  mocks.list.mockRejectedValueOnce(new Error('Network unavailable')).mockResolvedValue({ items: [], nextCursor: null });
  try {
    await act(async () =>
      root.render(
        <ToastProvider>
          <LibraryPage />
        </ToastProvider>,
      ),
    );
    expect(container.textContent).toContain('Could not load the library');
    expect(container.textContent).not.toContain('Nothing here yet');
    const retry = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Try again')!;
    await act(async () => retry.click());
    expect(container.textContent).not.toContain('Could not load the library');
    expect(container.textContent).toContain('Nothing here yet');
    expect(mocks.list).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
