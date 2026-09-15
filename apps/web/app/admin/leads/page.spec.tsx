// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@/components/ui';
import LeadsAdminPage from './page';

/**
 * The page exists so that a message a platform sent is read, so what is
 * pinned is that every field they typed is on the page — the notes behind
 * "Read" — that the address is something you can reply to, and that
 * "Mark handled" goes to the endpoint and refreshes the list.
 */

const mocks = vi.hoisted(() => ({
  leads: vi.fn(),
  setLeadHandled: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  api: { admin: { leads: mocks.leads, setLeadHandled: mocks.setLeadHandled } },
}));

const LEAD = {
  id: 'lead-1',
  organization: 'Bimbo Marketplace',
  email: 'ada@bimbomarket.ng',
  role: 'Head of Product',
  volume: '5,000 images and 200 reels',
  timeline: 'Before the December sale',
  notes: 'Our catalogue images are on Cloudinary behind signed URLs.',
  source: 'org-contact',
  handledAt: null,
  createdAt: '2026-09-15T09:00:00Z',
};

let root: Root;
let container: HTMLDivElement;
const button = (label: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  mocks.leads.mockResolvedValue({ rows: [LEAD], nextCursor: null });
  mocks.setLeadHandled.mockResolvedValue({ ...LEAD, handledAt: '2026-09-15T10:00:00Z' });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function open() {
  await act(async () => {
    root.render(
      <ToastProvider>
        <LeadsAdminPage />
      </ToastProvider>,
    );
  });
  await act(async () => {});
}

describe('platform leads', () => {
  it('shows the whole form, with the notes behind Read and the address as a reply link', async () => {
    await open();
    expect(mocks.leads).toHaveBeenCalledWith(expect.objectContaining({ show: 'open', take: 25 }));
    for (const s of ['Bimbo Marketplace', 'ada@bimbomarket.ng', 'Head of Product', '5,000 images and 200 reels', 'Before the December sale']) {
      expect(container.textContent).toContain(s);
    }
    expect(container.textContent).not.toContain('Cloudinary');
    await act(async () => button('Read').click());
    expect(container.textContent).toContain('Cloudinary');
    const link = container.querySelector('a[href^="mailto:"]') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toContain('mailto:ada@bimbomarket.ng');
  });

  it('marks a lead handled through the endpoint and reloads the list', async () => {
    await open();
    await act(async () => button('Mark handled').click());
    expect(mocks.setLeadHandled).toHaveBeenCalledWith('lead-1', true);
    expect(mocks.leads).toHaveBeenCalledTimes(2);
  });

  it('says plainly when nothing is waiting', async () => {
    mocks.leads.mockResolvedValue({ rows: [], nextCursor: null });
    await open();
    expect(container.textContent).toContain('Nothing waiting');
  });
});
