import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminTemplate } from '@/lib/api';
import { renderMissingExamples } from './renderExamples';

/**
 * This spends money, so what it refuses to do matters more than what it does.
 *
 * It must never re-render a template that already has an example, never pay
 * twice for the same one, and never abandon forty templates because one
 * provider refused one prompt.
 */

const mocks = vi.hoisted(() => ({ create: vi.fn(), get: vi.fn(), render: vi.fn() }));
vi.mock('@/lib/api', () => ({
  api: { generations: { create: mocks.create, get: mocks.get }, admin: { renderTemplate: mocks.render } },
}));

const template = (over: Partial<AdminTemplate> = {}): AdminTemplate => ({
  code: 'furniture_living_warm',
  name: 'Warm living room',
  note: 'Oak floor.',
  category: 'furniture',
  kind: 'scene',
  params: { prompt: 'A warm living room with soft morning light.' },
  thumbnailKey: null,
  swatch: { colors: ['#EFE4D6'], ink: 'dark' },
  keywords: null,
  active: true,
  sort: 10,
  operatorEdited: false,
  ...over,
});

const opts = (templates: AdminTemplate[], signal = new AbortController().signal) => ({
  workspaceId: 'ws-1',
  sourceKey: 'ws-1/stock.png',
  templates,
  reason: 'Filling the picker',
  onProgress: vi.fn(),
  signal,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  let n = 0;
  mocks.create.mockImplementation(async () => ({ generation: { id: `g-${++n}`, status: 'QUEUED' }, balance: 100 }));
  mocks.get.mockImplementation(async (_ws: string, id: string) => ({ generation: { id, status: 'SUCCEEDED', failureKind: null } }));
  mocks.render.mockResolvedValue({ code: 'x', thumbnailKey: 'templates/x.png', bytes: 1 });
});
afterEach(() => vi.useRealTimers());

describe('rendering the missing examples', () => {
  it('skips templates that already have one, and retired ones', async () => {
    // Re-running after a closed tab must cost only what it had not reached.
    const out = await renderMissingExamples(
      opts([template({ code: 'a' }), template({ code: 'b', thumbnailKey: 'templates/b.png' }), template({ code: 'c', active: false })]),
    );
    expect(out.total).toBe(1);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.render).toHaveBeenCalledWith('a', 'g-1', 'Filling the picker');
  });

  it('does nothing at all, and charges nothing, when every tile is filled', async () => {
    const out = await renderMissingExamples(opts([template({ thumbnailKey: 'templates/a.png' })]));
    expect(out.total).toBe(0);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('keys each job on its template, so a re-run joins the job in flight instead of paying again', async () => {
    await renderMissingExamples(opts([template({ code: 'furniture_patio' })]));
    expect(mocks.create).toHaveBeenCalledWith('ws-1', expect.objectContaining({ clientKey: 'template-example:furniture_patio' }));
  });

  it('sends a cut template to background removal and a scene to the edit models', async () => {
    await renderMissingExamples(opts([template({ code: 'a', kind: 'cut', params: { background: '#FFFFFF', prompt: '' } }), template({ code: 'b' })]));
    const capabilities = mocks.create.mock.calls.map((c) => (c[1] as { capability: string }).capability);
    expect(capabilities).toContain('BACKGROUND_REMOVE');
    expect(capabilities).toContain('IMAGE_EDIT');
  });

  it('preserves the product, because an example that redrew it is a lie about the template', async () => {
    await renderMissingExamples(opts([template()]));
    expect(mocks.create).toHaveBeenCalledWith('ws-1', expect.objectContaining({ params: expect.objectContaining({ preserveProduct: true }) }));
  });

  it('carries on past a failure and reports it, rather than abandoning the rest', async () => {
    mocks.get.mockImplementation(async (_ws: string, id: string) => ({
      generation: { id, status: id === 'g-1' ? 'FAILED' : 'SUCCEEDED', failureKind: 'LOW_QUALITY' },
    }));
    const out = await renderMissingExamples(opts([template({ code: 'a' }), template({ code: 'b' }), template({ code: 'c' })]));
    expect(out.done).toBe(3);
    expect(out.failures).toEqual([{ code: 'a', why: 'LOW_QUALITY' }]);
    // The two that worked were still promoted.
    expect(mocks.render).toHaveBeenCalledTimes(2);
  });

  it('never promotes a generation that did not succeed', async () => {
    mocks.get.mockResolvedValue({ generation: { id: 'g-1', status: 'FAILED', failureKind: 'PROVIDER_DOWN' } });
    const out = await renderMissingExamples(opts([template()]));
    expect(mocks.render).not.toHaveBeenCalled();
    expect(out.failures[0]!.why).toBe('PROVIDER_DOWN');
  });

  it('refuses a scene template with no prompt instead of paying for an empty one', async () => {
    const out = await renderMissingExamples(opts([template({ params: {} })]));
    expect(mocks.create).not.toHaveBeenCalled();
    expect(out.failures[0]!.why).toBe('no prompt to render');
  });

  it('stops when the operator stops it', async () => {
    const controller = new AbortController();
    controller.abort();
    const out = await renderMissingExamples(opts([template({ code: 'a' }), template({ code: 'b' })], controller.signal));
    expect(mocks.create).not.toHaveBeenCalled();
    expect(out.done).toBe(0);
  });

  it('reports progress as it goes, so the bar is not a guess', async () => {
    const o = opts([template({ code: 'a' }), template({ code: 'b' })]);
    await renderMissingExamples(o);
    const seen = o.onProgress.mock.calls.map((c) => (c[0] as { done: number }).done);
    expect(seen[0]).toBe(0);
    expect(seen[seen.length - 1]).toBe(2);
  });
});
