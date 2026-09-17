// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PlaygroundPage from './page';

/**
 * Every playground run is real money, so what is pinned is that the page
 * tells the truth and stops at the limits: the menu and its prices come
 * from the API (never a number in the page), the cost shown is the sum of
 * what is picked, a pick the balance cannot cover is refused before any
 * call, a run sends exactly the picked features with the name and details
 * to the playground endpoint (never to the studio's create), a pasted
 * image runs as an upload, an exhausted day disables the inputs, the copy
 * is shown whole (paragraph, bullets, specs), and the requests shown carry
 * the workspace's own key prefix.
 */

const mocks = vi.hoisted(() => ({
  playground: vi.fn(),
  run: vi.fn(),
  keys: vi.fn(),
  urls: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  fromUrl: vi.fn(),
  upload: vi.fn(),
  refreshBalance: vi.fn(),
  balance: 150 as number | null,
}));

vi.mock('@/lib/app-context', () => ({
  useApp: () => ({ workspace: { id: 'ws-org', role: 'OWNER' }, balance: mocks.balance, refreshBalance: mocks.refreshBalance }),
}));
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
    developer: { playground: mocks.playground, playgroundRun: mocks.run, keys: mocks.keys },
    media: { urls: mocks.urls, fromUrl: mocks.fromUrl },
    generations: { get: mocks.get, create: mocks.create, streamUrl: (w: string, id: string) => `/stream/${w}/${id}` },
    library: { downloadUrl: (w: string, id: string) => `/api/workspaces/${w}/library/${id}/download` },
  },
}));

const MENU = [
  { key: 'check', capability: 'INSPECT', label: 'Product check', help: '', kind: 'text', credits: 1 },
  { key: 'copy', capability: 'TEXT_GENERATE', label: 'Listing copy', help: '', kind: 'text', credits: 2 },
  { key: 'background', capability: 'BACKGROUND_REPLACE', label: 'Clean background', help: '', kind: 'image', credits: 10 },
  { key: 'product_alone', capability: 'PRODUCT_SHOT', label: 'Product alone', help: '', kind: 'image', credits: 10 },
  { key: 'cutout', capability: 'BACKGROUND_REMOVE', label: 'Cut-out', help: '', kind: 'image', credits: 2 },
  { key: 'enhance', capability: 'PRODUCT_SHOT', label: 'Enhance the photo', help: '', kind: 'image', credits: 10 },
  { key: 'reel', capability: 'IMAGE_TO_VIDEO', label: 'Reel', help: '', kind: 'video', credits: 120 },
  { key: 'ugc', capability: 'IMAGE_TO_VIDEO', label: 'UGC ad', help: '', kind: 'video', credits: 400 },
];
const allowance = (usedToday: number) => ({ dailyLimit: 15, usedToday, remaining: 15 - usedToday, resetsAt: '2099-01-01T00:00:00.000Z' });

let root: Root;
let container: HTMLDivElement;
const button = (label: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith(label)) as HTMLButtonElement;
const setter = () => Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('scrollTo', vi.fn()); // jsdom has no layout; the viewer restores the scroll position on close
  vi.stubGlobal(
    'EventSource',
    class {
      onmessage: ((e: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      close = vi.fn();
    },
  );
  vi.clearAllMocks();
  mocks.balance = 150;
  mocks.playground.mockResolvedValue({ ...allowance(3), features: MENU });
  mocks.keys.mockResolvedValue([{ id: 'k', prefix: 'as_test_a4f0', revokedAt: null }]);
  mocks.urls.mockResolvedValue({ urls: { 'ws/uploads/bag.jpg': 'https://cdn/bag.jpg' } });
  mocks.upload.mockResolvedValue({ id: 'asset-12345678-aaaa', key: 'ws/uploads/bag.jpg' });
  mocks.run.mockImplementation(async (_w: string, body: { features: string[] }) => ({
    runs: body.features.map((feature) => ({
      feature,
      capability: MENU.find((m) => m.key === feature)!.capability,
      generation: { id: `gen-${feature}`, status: 'QUEUED', stage: 'queued', outputs: null, credits: 1, input: { sourceKey: 'ws/uploads/bag.jpg' } },
    })),
    balance: 120,
    allowance: allowance(3 + body.features.length),
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
  it('shows the menu and prices from the API, and the cost of what is picked against the balance', async () => {
    await open();
    expect(mocks.playground).toHaveBeenCalledWith('ws-org');
    expect(container.textContent).toContain('12 of 15');
    for (const m of MENU) expect(container.textContent).toContain(m.label);
    expect(container.textContent).toContain('400 cr');
    expect(container.textContent).toContain('13 credits of your 150'); // check 1 + background 10 + copy 2
    await act(async () => button('Clean background').click());
    expect(container.textContent).toContain('3 credits of your 150');
  });

  it('refuses a pick the balance cannot cover, before any call', async () => {
    await open();
    await act(async () => button('UGC ad').click());
    expect(container.textContent).toContain('That is 413 credits and this workspace has 150');
    expect((container.querySelector('input[type="file"]') as HTMLInputElement).disabled).toBe(true);
    await act(async () => button('UGC ad').click());
    expect((container.querySelector('input[type="file"]') as HTMLInputElement).disabled).toBe(false);
  });

  it('sends exactly the picked features, with the name and details, to the playground endpoint — never to the studio create', async () => {
    await open();
    await act(async () => button('Clean background').click());
    await act(async () => button('Product alone').click());
    const name = container.querySelector('input[placeholder^="iPhone"]') as HTMLInputElement;
    await act(async () => {
      setter().call(name, 'iPhone 17 Pro');
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const details = container.querySelector('textarea') as HTMLTextAreaElement;
    const tset = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      tset.call(details, '256 GB, unlocked, boxed');
      details.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await dropPhoto();
    expect(mocks.run).toHaveBeenCalledWith('ws-org', {
      assetId: 'asset-12345678-aaaa',
      features: ['check', 'copy', 'product_alone'],
      title: 'iPhone 17 Pro',
      details: '256 GB, unlocked, boxed',
    });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(container.textContent).toContain('9 of 15');
    expect(container.textContent).toContain('Product alone');
  });

  it('runs a pasted image as an upload', async () => {
    await open();
    const file = new File(['x'], 'pasted.png', { type: 'image/png' });
    const target = container.querySelector('[aria-label="What to run"]') as HTMLElement;
    await act(async () => {
      const ev = new Event('paste', { bubbles: true }) as Event & { clipboardData: unknown };
      ev.clipboardData = { files: [file], getData: () => '' };
      target.dispatchEvent(ev);
    });
    await act(async () => {});
    expect(mocks.upload).toHaveBeenCalledWith('ws-org', file);
    expect(mocks.run).toHaveBeenCalledTimes(1);
  });

  it('shows the copy whole: the paragraph, the bullets and the specs', async () => {
    mocks.run.mockImplementationOnce(async () => ({
      runs: [
        {
          feature: 'copy',
          capability: 'TEXT_GENERATE',
          generation: {
            id: 'gen-copy',
            status: 'SUCCEEDED',
            stage: 'done',
            credits: 2,
            input: {},
            outputs: [
              {
                key: 'k',
                role: 'text',
                mime: 'application/json',
                text: {
                  seo: { title: 'Blue iPhone 17 Pro, 256 GB' },
                  description: {
                    long: 'A deep blue phone with three cameras.',
                    short: 's',
                    bullets: ['Three rear cameras', 'Unlocked'],
                    specs: [{ label: 'Colour', value: 'Blue' }],
                  },
                },
              },
            ],
          },
        },
      ],
      balance: 148,
      allowance: allowance(4),
    }));
    mocks.get.mockImplementation(async (_w: string, id: string) => ({
      generation: (await mocks.run.mock.results[0]!.value).runs.find((r: { generation: { id: string } }) => r.generation.id === id).generation,
    }));
    await open();
    await act(async () => button('Product check').click());
    await act(async () => button('Clean background').click());
    await dropPhoto();
    await act(async () => {});
    for (const s of ['Blue iPhone 17 Pro, 256 GB', 'three cameras', 'Three rear cameras', 'Colour', 'Blue']) expect(container.textContent).toContain(s);
  });

  it('says why a run failed in the API’s own words, not a blanket line', async () => {
    mocks.run.mockImplementationOnce(async () => ({
      runs: [
        {
          feature: 'background',
          capability: 'BACKGROUND_REPLACE',
          generation: { id: 'gen-background', status: 'FAILED', stage: 'failed', credits: 10, input: {}, outputs: null, failureKind: 'LOW_QUALITY' },
        },
      ],
      balance: 150,
      allowance: allowance(4),
    }));
    mocks.get.mockImplementation(async () => ({
      generation: (await mocks.run.mock.results[0]!.value).runs[0].generation,
      message: 'We could not make a version that kept your product looking right. Your credits are back — try a clearer photo or a simpler scene.',
    }));
    await open();
    await act(async () => button('Product check').click());
    await act(async () => button('Listing copy').click());
    await dropPhoto();
    await act(async () => {});
    expect(container.textContent).toContain('kept your product looking right');
    expect(container.textContent).not.toContain('Could not make it');
  });

  it('a finished picture opens at full size beside the original, and downloads as the files an integration would get', async () => {
    mocks.run.mockImplementationOnce(async () => ({
      runs: [
        {
          feature: 'background',
          capability: 'BACKGROUND_REPLACE',
          generation: {
            id: 'gen-bg',
            status: 'SUCCEEDED',
            stage: 'done',
            credits: 10,
            input: {},
            outputs: [
              { key: 'ws/out/bg.png', role: 'image', mime: 'image/png', width: 1024, height: 1280 },
              { key: 'ws/out/bg-story.jpg', role: 'variant', mime: 'image/jpeg', width: 1080, height: 1920, size: 'story' },
            ],
          },
        },
      ],
      balance: 140,
      allowance: allowance(4),
    }));
    mocks.get.mockImplementation(async () => ({ generation: (await mocks.run.mock.results[0]!.value).runs[0].generation }));
    mocks.urls.mockResolvedValue({
      urls: { 'ws/uploads/bag.jpg': 'https://cdn/bag.jpg', 'ws/out/bg.png': 'https://cdn/bg.png', 'ws/out/bg-story.jpg': 'https://cdn/bg-story.jpg' },
    });
    await open();
    await act(async () => button('Product check').click());
    await act(async () => button('Listing copy').click());
    await dropPhoto();
    await act(async () => {});

    const download = container.querySelector('a[href$="/library/gen-bg/download"]');
    expect(download?.textContent).toContain('Download');
    await act(async () => button('View').click());
    const viewer = document.querySelector('[aria-label="Photo at full size"]') as HTMLElement;
    expect(viewer).toBeTruthy();
    // Opens on the result; the original is one arrow away.
    expect(viewer.textContent).toContain('2 / 3');
    expect(viewer.querySelector('img')?.getAttribute('src')).toBe('https://cdn/bg.png');
    await act(async () => (viewer.querySelector('[aria-label="Previous"]') as HTMLButtonElement).click());
    expect(viewer.querySelector('img')?.getAttribute('src')).toBe('https://cdn/bag.jpg');
    await act(async () => (viewer.querySelector('[aria-label="Close"]') as HTMLButtonElement).click());
    expect(document.querySelector('[aria-label="Photo at full size"]')).toBeNull();
  });

  it('a failed card can be asked again, and one more feature can be added to the same photo', async () => {
    mocks.run.mockImplementationOnce(async () => ({
      runs: [
        {
          feature: 'background',
          capability: 'BACKGROUND_REPLACE',
          generation: { id: 'gen-bg', status: 'FAILED', stage: 'failed', credits: 10, input: {}, outputs: null, failureKind: 'LOW_QUALITY' },
        },
      ],
      balance: 150,
      allowance: allowance(4),
    }));
    mocks.get.mockImplementation(async () => ({
      generation: (await mocks.run.mock.results[0]!.value).runs[0].generation,
      message: 'We could not make a version that kept your product looking right.',
    }));
    await open();
    await act(async () => button('Product check').click());
    await act(async () => button('Listing copy').click());
    await dropPhoto();
    await act(async () => {});
    expect(container.textContent).toContain('kept your product looking right');

    await act(async () => button('Run again').click());
    expect(mocks.run).toHaveBeenLastCalledWith('ws-org', expect.objectContaining({ assetId: 'asset-12345678-aaaa', features: ['background'] }));

    // The rest of the menu is one tap away, priced, on the same photo.
    await act(async () => button('Reel').click());
    expect(mocks.run).toHaveBeenLastCalledWith('ws-org', expect.objectContaining({ assetId: 'asset-12345678-aaaa', features: ['reel'] }));
    expect(container.textContent).toContain('Reel');
  });

  it('stops at an exhausted day: the inputs are off and it says when the day resets', async () => {
    mocks.playground.mockResolvedValue({ ...allowance(15), features: MENU });
    await open();
    expect(container.textContent).toContain('0 of 15');
    expect((container.querySelector('input[type="file"]') as HTMLInputElement).disabled).toBe(true);
    expect((container.querySelector('input[aria-label="Listing link"]') as HTMLInputElement).disabled).toBe(true);
    expect(container.textContent).toContain('API key can keep going');
  });

  it('shows the request an integration would send, with the workspace’s own key prefix and the same clientKey', async () => {
    await open();
    await dropPhoto();
    await act(async () => button('Show the requests').click());
    const code = [...container.querySelectorAll('pre')].map((p) => p.textContent).join('\n');
    expect(code).toContain('Authorization: Bearer as_test_a4f0…');
    expect(code).toContain('"clientKey": "playground:asset-12:check:v1"');
    expect(code).toContain('"sourceKey": "ws/uploads/bag.jpg"');
  });
});
