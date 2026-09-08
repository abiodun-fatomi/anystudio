// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import TodayPage from './page';
const mocks = vi.hoisted(() => ({ overview: vi.fn(), setBalance: vi.fn(), workspace: { id: 'a', name: 'Shop' } }));
vi.mock('@/lib/app-context', () => ({ useApp: () => ({ me: { user: { name: 'Test' } }, workspace: mocks.workspace, setBalance: mocks.setBalance }) }));
vi.mock('@/lib/api', () => ({ api: { insights: { overview: mocks.overview }, wallet: { history: async () => ({ rows: [] }) } } }));

it('an older period request cannot overwrite the latest period error', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  const root = createRoot(container);
  let failOld!: (error: Error) => void;
  const old = new Promise((_, reject) => {
    failOld = reject;
  });
  mocks.overview.mockReturnValueOnce(old).mockRejectedValueOnce(new Error('Latest period unavailable'));
  try {
    await act(async () => root.render(<TodayPage />));
    const thirty = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '30 days')!;
    await act(async () => thirty.click());
    expect(container.textContent).toContain('Latest period unavailable');
    await act(async () => failOld(new Error('Old period unavailable')));
    expect(container.textContent).toContain('Latest period unavailable');
    expect(container.textContent).not.toContain('Old period unavailable');
    expect(mocks.setBalance).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
