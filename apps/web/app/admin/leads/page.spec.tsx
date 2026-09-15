// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@/components/ui';
import LeadsAdminPage from './page';

/**
 * The page exists so that a message a platform sent is read and answered,
 * so what is pinned is: everything is listed by default (no filter hides a
 * message until someone asks), the status and date filters reach the API
 * as sent, opening a row shows the whole message with a reply link that
 * carries the address and a subject, and "Mark handled" goes to the
 * endpoint and refreshes the list. The UI kit is real here, not mocked.
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
  volume: '5,000 to 50,000',
  timeline: 'This quarter',
  notes: 'Our catalogue images are on Cloudinary behind signed URLs.',
  source: 'org-contact',
  handledAt: null,
  createdAt: '2026-09-15T09:00:00Z',
};

let root: Root;
let container: HTMLDivElement;
const button = (label: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement;
const setter = () => Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;

/** jsdom ships <dialog> without showModal/close; the Dialog component calls them. */
function teachJsdomAboutDialogs() {
  const proto = window.HTMLDialogElement?.prototype as (HTMLDialogElement & { showModal?: () => void }) | undefined;
  if (!proto || typeof proto.showModal === 'function') return;
  proto.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true;
  };
  proto.close = function close(this: HTMLDialogElement) {
    this.open = false;
  };
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  teachJsdomAboutDialogs();
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
  it('lists everything by default, and shows who, how much and how soon on the row', async () => {
    await open();
    expect(mocks.leads).toHaveBeenCalledWith(expect.objectContaining({ status: 'all', from: undefined, to: undefined, take: 25 }));
    for (const s of ['Bimbo Marketplace', 'ada@bimbomarket.ng', 'Head of Product', '5,000 to 50,000', 'This quarter', 'Needs a reply']) {
      expect(container.textContent).toContain(s);
    }
    // the notes are behind the row, not on it
    expect(container.textContent).not.toContain('Cloudinary');
  });

  it('sends the status and the days to the API as chosen, and clears them again', async () => {
    await open();
    const status = container.querySelector('select') as HTMLSelectElement;
    await act(async () => {
      status.value = 'new';
      status.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(mocks.leads).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'new' }));
    const [from, to] = [...container.querySelectorAll('input[type="date"]')] as HTMLInputElement[];
    await act(async () => {
      setter().call(from!, '2026-09-01');
      from!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      setter().call(to!, '2026-09-15');
      to!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(mocks.leads).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'new', from: '2026-09-01', to: '2026-09-15' }));
    await act(async () => button('Clear filters').click());
    expect(mocks.leads).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'all', from: undefined, to: undefined }));
  });

  it('opens the whole message, with a reply link carrying the address and a subject', async () => {
    await open();
    await act(async () => button('Open').click());
    expect(container.textContent).toContain('Cloudinary');
    expect(container.textContent).toContain('Wants to be live');
    const reply = [...container.querySelectorAll('a')].find((a) => a.textContent?.trim() === 'Reply by email') as HTMLAnchorElement;
    expect(reply.getAttribute('href')).toBe('mailto:ada@bimbomarket.ng?subject=AnyStudio%20%E2%80%94%20Bimbo%20Marketplace');
  });

  it('marks a message handled through the endpoint and reloads the list', async () => {
    await open();
    await act(async () => button('Open').click());
    await act(async () => button('Mark handled').click());
    expect(mocks.setLeadHandled).toHaveBeenCalledWith('lead-1', true);
    expect(mocks.leads).toHaveBeenCalledTimes(2);
    expect(button('Open again')).toBeDefined();
  });

  it('says plainly when nothing is there, and when a filter is why', async () => {
    mocks.leads.mockResolvedValue({ rows: [], nextCursor: null });
    await open();
    expect(container.textContent).toContain('No platform has written in yet');
    const status = container.querySelector('select') as HTMLSelectElement;
    await act(async () => {
      status.value = 'handled';
      status.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(container.textContent).toContain('Nothing matches');
  });
});
