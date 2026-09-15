// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PlaygroundPage from './page';

/**
 * Every playground run is real money, so what is pinned is that the page
 * tells the truth about the allowance and stops at it: the figure comes
 * from the API, the cost shown is the sum of the calls picked, a run sends
 * exactly the picked calls to the playground endpoint (never to the studio's
 * create), an exhausted day disables the inputs and says when it resets,
 * and the requests shown afterwards carry the workspace's own key prefix.
 */

const mocks = vi.hoisted(() => ({
  allowance: vi.fn(),
  run: vi.fn(),
  keys: vi.fn(),
  urls: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  fromUrl: vi.fn(),
  upload: vi.fn(),
  refreshBalance: vi.fn(),
}));

vi.mock('@/lib/app-context', () => ({ useApp: () => ({ workspace: { id: 'ws-org', role: 'OWNER' }, refreshBalance: mocks.refreshBalance }) }));
vi.mock('@/lib/upload', () => ({ uploadFile: mocks.upload }));
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
    developer: { playground: mocks.allowance, playgroundRun: mocks.run, keys: mocks.keys },
    media: { urls: mocks.urls, fromUrl: mocks.fromUrl },
    generations: { get: mocks.get, create: mocks.create, streamUrl: (w: string, id: string) => `/stream/${w}/${id}` },
  },
}));

let root: Root;
let container: HTMLDivElement;
const button = (label: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith(label)) as HTMLButtonElement;

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
  mocks.allowance.mockResolvedValue({ dailyLimit: 15, usedToday: 3, remaining: 12, resetsAt: '2099-01-01T00:00:00.000Z' });
  mocks.keys.mockResolvedValue([{ id: 'k', prefix: 'as_test_a4f0', revokedAt: null }]);
  mocks.urls.mockResolvedValue({ urls: { 'ws/uploads/bag.jpg': 'https://cdn/bag.jpg' } });
  mocks.upload.mockResolvedValue({ id: 'asset-12345678-aaaa', key: 'ws/uploads/bag.jpg' });
  mocks.run.mockImplementation(async (_w: string, body: { capabilities: string[] }) => ({
    runs: body.capabilities.map((capability) => ({
      capability,
      generation: { id: `gen-${capability}`, status: 'QUEUED', stage: 'queued', outputs: null, credits: 1 },
    })),
    balance: 120,
    allowance: { dailyLimit: 15, usedToday: 3 + body.capabilities.length, remaining: 12 - body.capabilities.length, resetsAt: '2099-01-01T00:00:00.000Z' },
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
  await act(async () => root.render(<PlaygroundPage />));
  await act(async () => {});
}

async function dropPhoto() {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File(['x'], 'bag.jpg', { type: 'image/jpeg' });
  Object.defineProperty(input, 'files', { value: [file] });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
  await act(async () => {});
}

describe('the playground', () => {
  it('shows the allowance from the API and the cost of what is picked', async () => {
    await open();
    expect(mocks.allowance).toHaveBeenCalledWith('ws-org');
    expect(container.textContent).toContain('12 of 15');
    expect(container.textContent).toContain('13 credits'); // 1 + 10 + 2
    await act(async () => button('Clean background').click());
    expect(container.textContent).toContain('3 credits');
    expect(button('Clean background').getAttribute('aria-pressed')).toBe('false');
  });

  it('sends exactly the picked calls to the playground endpoint, never to the studio create', async () => {
    await open();
    await act(async () => button('Clean background').click());
    await dropPhoto();
    expect(mocks.upload).toHaveBeenCalledWith('ws-org', expect.any(File));
    expect(mocks.run).toHaveBeenCalledWith('ws-org', { assetId: 'asset-12345678-aaaa', capabilities: ['INSPECT', 'TEXT_GENERATE'] });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(container.textContent).toContain('10 of 15');
    expect(mocks.refreshBalance).toHaveBeenCalled();
  });

  it('shows the request an integration would send, with the workspace’s own key prefix and the same clientKey', async () => {
    await open();
    await dropPhoto();
    await act(async () => button('Show the requests').click());
    const code = [...container.querySelectorAll('pre')].map((p) => p.textContent).join('\n');
    expect(code).toContain('Authorization: Bearer as_test_a4f0…');
    expect(code).toContain('"clientKey": "playground:asset-12:inspect:v1"');
    expect(code).toContain('"sourceKey": "ws/uploads/bag.jpg"');
  });

  it('stops at an exhausted day: the inputs are off and it says when the day resets', async () => {
    mocks.allowance.mockResolvedValue({ dailyLimit: 15, usedToday: 15, remaining: 0, resetsAt: '2099-01-01T00:00:00.000Z' });
    await open();
    expect(container.textContent).toContain('0 of 15');
    expect((container.querySelector('input[type="file"]') as HTMLInputElement).disabled).toBe(true);
    expect((container.querySelector('input[aria-label="Listing link"]') as HTMLInputElement).disabled).toBe(true);
    expect(container.textContent).toContain('resets');
    expect(container.textContent).toContain('API key can keep going');
  });

  it('carries the API’s own words when a run is refused', async () => {
    const { ApiError } = await import('@/lib/api');
    mocks.run.mockRejectedValue(new ApiError(429, 'playground_exhausted', "Today's playground allowance (15 runs) is used up."));
    await open();
    await dropPhoto();
    expect(container.textContent).toContain("Today's playground allowance (15 runs) is used up.");
    expect(mocks.allowance).toHaveBeenCalledTimes(2); // re-read after the refusal
  });
});
