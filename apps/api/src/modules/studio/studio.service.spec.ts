import { describe, expect, it, vi } from 'vitest';
import { StudioService } from './studio.service';

function make(answer: unknown | (() => never)) {
  const provider = {
    key: 'fake:llm',
    generate: vi.fn(async () => {
      if (typeof answer === 'function') (answer as () => never)();
      return { providerKey: 'fake:llm', artifacts: [{ mime: 'application/json', role: 'text', text: answer }] };
    }),
  };
  const db = {
    workspace: {
      findUniqueOrThrow: vi.fn(async () => ({ id: 'ws', type: 'BUSINESS', region: 'ng', currency: 'NGN', profile: { sells: 'Ankara bags', tone: 'warm' } })),
    },
    brandKit: { findUnique: vi.fn(async () => null) },
    mediaAsset: { findFirst: vi.fn(async () => ({ mime: 'image/jpeg' })) },
  };
  const media = { readUrl: vi.fn(async () => 'https://signed/photo.jpg') };
  const router = { route: vi.fn(async () => ({ capability: 'TEXT_GENERATE', candidates: [{ row: { config: null }, provider }], excluded: [] })) };
  const svc = new StudioService(db as never, media as never, router as never);
  return { svc, provider, media };
}

const good = {
  product: 'Ankara tote bag',
  ideas: [
    {
      title: 'The stitching first',
      prompt: 'Start tight on the stitching, pull back to the bag on a rattan chair in window light.',
      motion: 'slow pull-back',
      why: 'Detail justifies the price.',
    },
    {
      title: 'Market morning',
      prompt: 'The bag on a shoulder at a Lagos market stall, handheld, morning light.',
      motion: 'handheld',
      why: 'Buyers see it in their life.',
    },
    {
      title: 'Gift wrapped',
      prompt: 'The bag folded into tissue paper in a box being opened on a table.',
      motion: 'tilt up',
      why: 'Gifting is the reason people buy this month.',
    },
  ],
};

describe('StudioService.ideas', () => {
  it('asks the model with the photo and the seller context, and returns its three directions', async () => {
    const { svc, provider, media } = make(good);
    const out = await svc.ideas('ws', { tool: 'video', sourceKey: 'ws/photo.jpg', format: 'reveal', shots: 4 });
    expect(out.source).toBe('model');
    expect(out.product).toBe('Ankara tote bag');
    expect(out.ideas).toHaveLength(3);
    expect(out.ideas[0]!.motion).toBe('slow pull-back');
    expect(media.readUrl).toHaveBeenCalledWith('ws', 'ws/photo.jpg');
    const input = provider.generate.mock.calls[0]![0] as { prompt: { system: string; parts: unknown[] } };
    expect(input.prompt.system).toMatch(/Ankara bags/);
    expect(input.prompt.system).toMatch(/30-second ad in 4 shots/);
    expect(input.prompt.parts[0]).toEqual({ imageUrl: 'https://signed/photo.jpg', mime: 'image/jpeg' });
  });

  it('drops the camera move for image tools', async () => {
    const { svc } = make(good);
    const out = await svc.ideas('ws', { tool: 'scene', sourceKey: 'ws/photo.jpg' });
    expect(out.ideas.every((i) => i.motion === undefined)).toBe(true);
  });

  it('falls back to stock ideas, labelled, when the model answers off-structure or fails', async () => {
    const { svc } = make({ nonsense: true });
    const out = await svc.ideas('ws', { tool: 'video', shots: 1 });
    expect(out.source).toBe('stock');
    expect(out.ideas).toHaveLength(3);
    const failing = make(() => {
      throw new Error('vendor down');
    });
    expect((await failing.svc.ideas('ws', { tool: 'background' })).source).toBe('stock');
  });

  it('answers the same question from cache and a new round from the model', async () => {
    const { svc, provider } = make(good);
    await svc.ideas('ws', { tool: 'video', sourceKey: 'k', shots: 2 });
    await svc.ideas('ws', { tool: 'video', sourceKey: 'k', shots: 2 });
    expect(provider.generate).toHaveBeenCalledTimes(1);
    await svc.ideas('ws', { tool: 'video', sourceKey: 'k', shots: 2, round: 1 });
    expect(provider.generate).toHaveBeenCalledTimes(2);
  });
});
