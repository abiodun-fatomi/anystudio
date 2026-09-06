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

describe('StudioService.captions', () => {
  const answer = {
    product: 'Ankara tote bag',
    captions: [
      {
        angle: 'Straight offer',
        text: 'New ankara totes, ₦12,000. Send a message to order — Lagos delivery today.',
        hashtags: ['#ankara', 'lagosvendor', 'tote bag'],
        why: 'Price and how to buy, first line.',
      },
      { angle: 'The question', text: 'Which print is yours?', hashtags: ['ankara'], why: 'Earns replies.' },
      { angle: 'The detail', text: 'Lined, zipped, made to carry a laptop.', hashtags: ['handmade'], why: 'Answers the doubt.' },
    ],
  };

  it('aims the model at the platform and the goal, and cleans the hashtags', async () => {
    const { svc, provider } = make(answer);
    const out = await svc.captions('ws', { sourceKey: 'ws/photo.jpg', platform: 'instagram', kind: 'feed', goal: 'sell', price: '₦12,000' });
    expect(out.source).toBe('model');
    expect(out.captions[0]!.hashtags).toEqual(['ankara', 'lagosvendor', 'totebag']);
    const input = provider.generate.mock.calls[0]![0] as { prompt: { system: string } };
    expect(input.prompt.system).toMatch(/Instagram/);
    expect(input.prompt.system).toMatch(/sell now/);
    expect(input.prompt.system).toMatch(/Ankara bags/);
  });

  it('drops hashtags for WhatsApp and falls back to stock captions when the model fails', async () => {
    const { svc } = make(answer);
    const out = await svc.captions('ws', { platform: 'whatsapp', goal: 'message' });
    expect(out.captions.every((c) => c.hashtags.length === 0)).toBe(true);
    const failing = make(() => {
      throw new Error('down');
    });
    expect((await failing.svc.captions('ws', { platform: 'instagram' })).source).toBe('stock');
  });
});

describe('when no model answers', () => {
  it('rotates the fallback so asking again is never the same three, and never caches a failure', async () => {
    const boom = () => {
      throw new Error('vendor down');
    };
    const { svc, provider } = make(boom);
    const a = await svc.ideas('ws', { tool: 'video', sourceKey: 'k' });
    const b = await svc.ideas('ws', { tool: 'video', sourceKey: 'k', round: 1 });
    expect(a.source).toBe('stock');
    expect(b.source).toBe('stock');
    expect(b.ideas.map((i) => i.title)).not.toEqual(a.ideas.map((i) => i.title));
    // Outside production the reason travels with it, so a blank box is explainable.
    expect(a.reason).toMatch(/vendor down/);
    // The same question again still asks the model rather than serving the cached fallback.
    await svc.ideas('ws', { tool: 'video', sourceKey: 'k' });
    expect(provider.generate).toHaveBeenCalledTimes(3);
  });

  it('rotates the fallback captions too, and still drops hashtags for WhatsApp', async () => {
    const { svc } = make(() => {
      throw new Error('down');
    });
    const a = await svc.captions('ws', { platform: 'instagram' });
    const b = await svc.captions('ws', { platform: 'whatsapp', round: 1 });
    expect(a.captions.map((c) => c.angle)).not.toEqual(b.captions.map((c) => c.angle));
    expect(b.captions.every((c) => c.hashtags.length === 0)).toBe(true);
  });
});
