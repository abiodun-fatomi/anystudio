// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OrganizationWelcome from './page';

/**
 * The organization's welcome does real things, so what is pinned is that it
 * does them once and only when it should: a key is minted when there is none
 * and never re-minted on a reload; the verify step reads the profile rather
 * than trusting a button; a listing link goes through the page reader; the
 * demo's three calls are the three the platforms page promises, keyed so a
 * retry cannot charge twice; and invites go to the members endpoint at the
 * role chosen. The UI kit is real here, not mocked: this page shipped
 * crashing at prerender on `useToast must be used inside ToastProvider`
 * while a mocked useToast kept this file green, so the provider the page
 * brings for itself is now part of what is under test.
 */

const mocks = vi.hoisted(() => ({
  me: { user: { name: 'Ada', email: 'ada@bimbomarket.ng' }, workspaces: [{ id: 'ws-org', type: 'ORGANIZATION', name: 'Bimbo Marketplace' }] },
  profile: vi.fn(),
  resend: vi.fn(),
  keys: vi.fn(),
  projects: vi.fn(),
  createProject: vi.fn(),
  createKey: vi.fn(),
  fromUrl: vi.fn(),
  urls: vi.fn(),
  create: vi.fn(),
  get: vi.fn(),
  invite: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push, replace: mocks.replace }) }));
vi.mock('@/lib/useMe', () => ({ useMe: () => ({ me: mocks.me }) }));
vi.mock('@/lib/hosts', () => ({ siblingOrigin: () => 'https://api.example.test' }));
vi.mock('@/lib/upload', () => ({ uploadFile: vi.fn() }));
vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {
    constructor(
      readonly status: number,
      readonly code: string,
      message: string,
      readonly requestId?: string,
      readonly fields?: Array<{ path: string; message: string }>,
    ) {
      super(message);
    }
  },
  api: {
    account: { profile: mocks.profile },
    auth: { resendVerification: mocks.resend },
    developer: { keys: mocks.keys, projects: mocks.projects, createProject: mocks.createProject, createKey: mocks.createKey },
    media: { fromUrl: mocks.fromUrl, urls: mocks.urls },
    generations: { create: mocks.create, get: mocks.get, streamUrl: (w: string, id: string) => `/stream/${w}/${id}` },
    members: { invite: mocks.invite },
  },
}));

let root: Root;
let container: HTMLDivElement;
const button = (label: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement;
const click = (label: string) => act(async () => button(label).click());

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'EventSource',
    class {
      onmessage: ((e: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      close = vi.fn();
    },
  );
  vi.clearAllMocks();
  mocks.profile.mockResolvedValue({ emailVerifiedAt: null });
  mocks.keys.mockResolvedValue([]);
  mocks.projects.mockResolvedValue([]);
  mocks.createProject.mockResolvedValue({ id: 'proj-1', name: 'Sandbox', archivedAt: null });
  mocks.createKey.mockResolvedValue({ id: 'key-1', prefix: 'as_test_a4f0', key: 'as_test_a4f0c1b9e2d7full' });
  mocks.urls.mockResolvedValue({ urls: {} });
  mocks.create.mockImplementation(async (_w: string, body: { capability: string }) => ({
    generation: { id: `gen-${body.capability}`, status: 'QUEUED', stage: 'queued', outputs: null, credits: 1 },
    balance: 100,
  }));
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
  await act(async () => root.render(<OrganizationWelcome />));
}

describe('verify', () => {
  it('reads the profile rather than trusting the button, and moves on only once the link was used', async () => {
    await open();
    expect(container.textContent).toContain('ada@bimbomarket.ng');
    await click("I've verified — continue");
    expect(container.textContent).toContain("hasn't been opened");
    mocks.profile.mockResolvedValue({ emailVerifiedAt: '2026-09-15T10:00:00Z' });
    await click("I've verified — continue");
    expect(container.textContent).toContain('Your key');
  });

  it('sends the verification again through the real endpoint', async () => {
    mocks.resend.mockResolvedValue({ status: 'sent' });
    await open();
    await click('Send it again');
    expect(mocks.resend).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Sent again');
  });
});

describe('the key', () => {
  it('mints one key in a Sandbox project when there is none, and shows it once', async () => {
    await open();
    await click('Verify later');
    await act(async () => {});
    expect(mocks.createProject).toHaveBeenCalledWith('ws-org', expect.objectContaining({ name: 'Sandbox' }));
    expect(mocks.createKey).toHaveBeenCalledTimes(1);
    expect(mocks.createKey).toHaveBeenCalledWith('ws-org', { projectId: 'proj-1', name: 'First key' });
    expect(container.textContent).toContain('as_test_a4f0c1b9e2d7full');
    expect(container.textContent).toContain('Copy it now');
  });

  it('never mints a second key on a reload — an existing key is shown by its prefix', async () => {
    mocks.keys.mockResolvedValue([{ id: 'key-0', prefix: 'as_test_zz11', revokedAt: null }]);
    await open();
    await click('Verify later');
    await act(async () => {});
    expect(mocks.createKey).not.toHaveBeenCalled();
    expect(mocks.createProject).not.toHaveBeenCalled();
    expect(container.textContent).toContain('as_test_zz11');
    expect(container.textContent).toContain('already issued');
  });

  it('reuses an existing project rather than making a second Sandbox', async () => {
    mocks.projects.mockResolvedValue([{ id: 'proj-live', name: 'Marketplace', archivedAt: null }]);
    await open();
    await click('Verify later');
    await act(async () => {});
    expect(mocks.createProject).not.toHaveBeenCalled();
    expect(mocks.createKey).toHaveBeenCalledWith('ws-org', expect.objectContaining({ projectId: 'proj-live' }));
  });
});

describe('the demo', () => {
  async function toProve() {
    await open();
    await click('Verify later');
    await act(async () => {});
    await click('Run it on your catalogue');
  }

  it('reads a listing link through the page reader and runs the three promised calls, keyed against a double charge', async () => {
    mocks.fromUrl.mockResolvedValue({ asset: { id: 'asset-12345678', key: 'ws/uploads/bag.jpg' }, title: 'Mini handbag', pageUrl: 'https://shop.ng/p/1' });
    await toProve();
    const input = container.querySelector('input[aria-label="Listing link"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(input, 'https://shop.ng/p/1');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click('Fetch it');
    expect(mocks.fromUrl).toHaveBeenCalledWith('ws-org', 'https://shop.ng/p/1');
    const bodies = mocks.create.mock.calls.map((c) => c[1] as { capability: string; params: Record<string, unknown>; clientKey: string });
    expect(bodies.map((b) => b.capability).sort()).toEqual(['BACKGROUND_REPLACE', 'INSPECT', 'TEXT_GENERATE']);
    // The page's title is what the check compares against and what the copy is named after.
    expect(bodies.find((b) => b.capability === 'INSPECT')!.params).toEqual({ sourceKey: 'ws/uploads/bag.jpg', declared: { name: 'Mini handbag' } });
    expect(bodies.find((b) => b.capability === 'TEXT_GENERATE')!.params).toMatchObject({ sourceKey: 'ws/uploads/bag.jpg', productName: 'Mini handbag' });
    for (const b of bodies) expect(b.clientKey).toBe(`welcome:asset-12:${b.capability.toLowerCase()}:v1`);
    expect(container.textContent).toContain('Mini handbag');
  });

  it('says why a link could not be read, in the server’s own words', async () => {
    const { ApiError } = await import('@/lib/api');
    mocks.fromUrl.mockRejectedValue(
      new ApiError(400, 'invalid_input', 'Some of that did not look right.', undefined, [{ path: 'url', message: 'The link answered 404.' }]),
    );
    await toProve();
    const input = container.querySelector('input[aria-label="Listing link"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(input, 'https://shop.ng/gone');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click('Fetch it');
    expect(container.textContent).toContain('The link answered 404.');
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

describe('the team', () => {
  it('sends each invite to the members endpoint at the chosen role, and reports each one', async () => {
    const { ApiError } = await import('@/lib/api');
    mocks.invite.mockResolvedValueOnce({ id: 'i1' }).mockRejectedValueOnce(new ApiError(409, 'conflict', 'already a member'));
    await open();
    await click('Verify later');
    await act(async () => {});
    await click('Skip the demo');
    await click('Skip the demo');
    const inputs = [...container.querySelectorAll('input[type="email"]')] as HTMLInputElement[];
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(inputs[0]!, 'tunde@bimbomarket.ng');
      inputs[0]!.dispatchEvent(new Event('input', { bubbles: true }));
      setter.call(inputs[1]!, 'ngozi@bimbomarket.ng');
      inputs[1]!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const roles = [...container.querySelectorAll('select')] as HTMLSelectElement[];
    await act(async () => {
      roles[0]!.value = 'ADMIN';
      roles[0]!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await click('Send the invites');
    expect(mocks.invite).toHaveBeenNthCalledWith(1, 'ws-org', 'tunde@bimbomarket.ng', 'ADMIN');
    expect(mocks.invite).toHaveBeenNthCalledWith(2, 'ws-org', 'ngozi@bimbomarket.ng', 'MEMBER');
    expect(container.textContent).toContain('already a member');
    await click('Open the portal');
    expect(mocks.push).toHaveBeenCalledWith('/developer');
  });
});
