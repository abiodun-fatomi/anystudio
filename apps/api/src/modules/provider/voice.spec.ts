/**
 * Whose studio it is.
 *
 * A merchant watching a video render saw "fal is generating". They have never
 * heard of fal, they did not choose fal, and the whole point of the provider
 * plane is that an operator can move that capability to another vendor during
 * an outage without a deploy — at which point every sentence naming fal is
 * silently a lie.
 *
 * Two layers, both tested here. The adapters are written in the product's
 * voice, and the events chokepoint replaces any line that is not — so a new
 * adapter written next year, or a vendor's own status string echoed back,
 * still cannot put a supplier's name in front of a customer.
 *
 * The last test reads the adapter source. It is the one that will actually
 * catch the next person, including a future me.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STAGE_FALLBACK, VENDOR_WORDS, inOurVoice, namesAVendor } from '@anystudio/shared';
import { forCustomer } from '../generation/generation.service';

describe('spotting a name a customer should not see', () => {
  it('catches every vendor and model we route to', () => {
    for (const w of ['fal is generating', 'Veo is rendering', 'HeyGen is translating', 'queued at fal', 'asking Gemini', 'Photoroom is editing'])
      expect(namesAVendor(w), w).toBe(true);
  });

  it('leaves ordinary progress alone', () => {
    for (const w of ['Rendering your video', 'Making it', 'Cutting out your product', 'Matching the mouth to the words', 'Waiting for a rendering slot'])
      expect(namesAVendor(w), w).toBe(false);
  });

  it('does not fire on words that merely contain a vendor name', () => {
    // "falling" is not fal, "syncing" is not sync, "wandering" is not wan.
    for (const w of ['The petals are falling', 'Syncing your library', 'Wandering the market', 'Claudia is the model']) expect(namesAVendor(w), w).toBe(false);
  });
});

describe('saying it in our own voice', () => {
  it('replaces a line wholesale rather than editing the name out of it', () => {
    // Deleting the word would leave "is generating", which reads like a bug.
    expect(inOurVoice('fal is generating', 'Making it')).toBe('Making it');
  });

  it('passes through anything already in our voice', () => {
    expect(inOurVoice('Rendering your video (12s)')).toBe('Rendering your video (12s)');
  });

  it('has something true to say at every stage', () => {
    for (const stage of ['queued', 'preparing', 'routing', 'generating', 'composing', 'waiting', 'storing']) {
      expect(STAGE_FALLBACK[stage], stage).toBeTruthy();
      expect(namesAVendor(STAGE_FALLBACK[stage]!), stage).toBe(false);
    }
  });

  it('says nothing when there was nothing to say', () => {
    expect(inOurVoice(undefined)).toBeUndefined();
    expect(inOurVoice('')).toBeUndefined();
  });
});

/**
 * The one that catches the next person.
 *
 * The chokepoint means a leak degrades to a generic line rather than showing
 * a vendor — but a generic line is a worse progress bar than one that says
 * what is happening. So the adapters are held to the standard directly.
 */
describe('every adapter, at the source', () => {
  const dir = join(__dirname, 'adapters');
  const files = readdirSync(dir).filter((f) => f.endsWith('.adapter.ts'));

  const linesIn = (file: string): string[] => {
    const source = readFileSync(join(dir, file), 'utf8');
    return [...source.matchAll(/onProgress\?\.\(\s*([`'"])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2]!);
  };

  it('has adapters to check', () => {
    expect(files.length).toBeGreaterThan(8);
  });

  // Without this the scan could pass by finding nothing at all.
  it('actually finds the progress lines it is checking', () => {
    const all = files.flatMap(linesIn);
    expect(all.length, 'the scanner found no progress lines — the pattern has drifted').toBeGreaterThan(15);
    // And it finds the real ones, in our voice.
    expect(all).toContain('Rendering your video');
    expect(all).toContain('Editing your photo');
  });

  it.each(files)('%s tells the customer what is happening, not who is doing it', (file) => {
    const offenders = linesIn(file).filter(namesAVendor);
    expect(offenders.join(' | '), `\n${file} shows: ${offenders.join(' | ')}\n`).toBe('');
  });
});

describe('the guard list', () => {
  it('names every house we actually route to', () => {
    for (const v of ['fal', 'elevenlabs', 'heygen', 'higgsfield', 'photoroom', 'replicate', 'openai', 'google', 'bfl']) expect(VENDOR_WORDS).toContain(v);
  });

  it('names the models too, because a model is a supplier by another name', () => {
    for (const m of ['veo', 'sora', 'flux', 'gemini', 'seedream', 'birefnet']) expect(VENDOR_WORDS).toContain(m);
  });
});

/**
 * The same leak, one layer down.
 *
 * None of this is rendered in the studio — but it rode along in the JSON, and
 * a merchant with the network tab open could read which supplier had the GPU
 * this morning, the vendor's own error text, and what we paid for the call.
 * The last of those is the margin, on every generation they have ever made.
 */
describe('a generation row, as the customer may see it', () => {
  const row = {
    id: 'g1',
    workspaceId: 'ws',
    status: 'FAILED',
    failureKind: 'LOW_QUALITY',
    failureReason: 'fal: HTTP 422 product fidelity 0.41 on two attempts',
    providerKey: 'fal:wan-2.5-i2v',
    providerJobId: 'fal-req-88213',
    providerCostMinor: 47,
    credits: 120,
    outputs: null,
    children: [{ id: 'c1', providerKey: 'openai:sora-2', providerJobId: 'x', providerCostMinor: 12, failureReason: 'Sora said no', outputs: null }],
  } as never;

  it('says nothing about which supplier did the work', () => {
    const seen = forCustomer(row) as unknown as Record<string, unknown>;
    expect(seen.providerKey).toBeNull();
    expect(seen.providerJobId).toBeNull();
  });

  it('does not hand over what the vendor charged us', () => {
    expect((forCustomer(row) as unknown as Record<string, unknown>).providerCostMinor).toBeNull();
  });

  it('drops the vendor’s own failure text, which is where their name usually is', () => {
    const seen = forCustomer(row) as unknown as Record<string, unknown>;
    expect(seen.failureReason).toBeNull();
    // The category stays: it is ours, it names nobody, and it chooses the
    // sentence the customer actually reads.
    expect(seen.failureKind).toBe('LOW_QUALITY');
  });

  it('redacts the children too — an ad hides its shots’ suppliers as well as its own', () => {
    const child = (forCustomer(row) as unknown as { children: Array<Record<string, unknown>> }).children[0]!;
    expect(child.providerKey).toBeNull();
    expect(child.providerCostMinor).toBeNull();
    expect(child.failureReason).toBeNull();
  });

  it('leaves everything the studio actually needs', () => {
    const seen = forCustomer(row) as unknown as Record<string, unknown>;
    expect(seen.id).toBe('g1');
    expect(seen.status).toBe('FAILED');
    expect(seen.credits).toBe(120);
  });

  it('has nothing left in it that names a vendor', () => {
    expect(namesAVendor(JSON.stringify(forCustomer(row)))).toBe(false);
  });
});
