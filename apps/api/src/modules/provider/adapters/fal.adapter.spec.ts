/**
 * The clip length we ask fal for.
 *
 * Our plans are built on 5 and 8 seconds. wan-2.5 takes 5 or 10, and answers
 * an 8 with
 *
 *   {"type":"literal_error","loc":["body","duration"],"msg":"Input should be '5' or '10'","input":"8"}
 *
 * before it renders anything — three of every four shots in a 30-second ad,
 * each one then falling through to another paid provider against
 * fal's 80. The bug was billed as well as logged.
 *
 * These tests are about which length we send, not about the vendor call.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderInput } from '@anystudio/shared';
import { FalProvider, lipsyncModel, snapDuration, WAN_PROMPT_MAX, wanPrompt } from './fal.adapter';

const WAN = [5, 10] as const;

describe('choosing a clip length a vendor will accept', () => {
  it('sends what the plan asked for when the vendor accepts it', () => {
    expect(snapDuration(5, WAN)).toBe(5);
    expect(snapDuration(10, WAN)).toBe(10);
  });

  it('never sends a length the vendor has said it will refuse', () => {
    // The reproduction. Whatever it picks, it must not be 8.
    expect(snapDuration(8, WAN)).not.toBe(8);
    expect(WAN).toContain(snapDuration(8, WAN));
  });

  it('rounds a standalone clip down so it cannot run long', () => {
    // Standalone output is not sent through our stitcher, so it cannot trim a
    // 10-second result back to the requested eight.
    expect(snapDuration(8, WAN)).toBe(5);
  });

  it('covers a stitched shot so the media worker can trim it to the paid slot', () => {
    expect(snapDuration(8, WAN, true)).toBe(10);
  });

  it('takes the shortest on offer when everything the vendor has runs long', () => {
    expect(snapDuration(3, WAN)).toBe(5);
  });

  it('leaves the length alone for an endpoint with no grid of its own', () => {
    // Most vendors take both of ours; absent a table we must not invent one.
    expect(snapDuration(8, undefined)).toBe(8);
    expect(snapDuration(8, [])).toBe(8);
  });
});

describe('choosing the lip-sync model', () => {
  it('does not let a seeded speed default downgrade a precision request', () => {
    expect(lipsyncModel('precision', 'lipsync-2')).toBe('lipsync-2-pro');
    expect(lipsyncModel('speed', 'lipsync-2')).toBe('lipsync-2');
  });
});

afterEach(() => vi.unstubAllGlobals());

describe('completed fal queue validation failures', () => {
  it.each([
    [422, { detail: [{ loc: ['body', 'image_url'], type: 'value_error', msg: 'The image is too large to upscale.' }] }, true],
    [422, { detail: 'unknown result' }, false],
    [401, { detail: 'Unauthorized' }, false],
    [404, { detail: 'Not found' }, false],
    [503, { detail: 'Unavailable' }, false],
  ])('settles only definitive validation responses (%i, %j)', async (status, body, terminal) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (url: string | URL | Request) =>
          new Response(JSON.stringify(String(url).includes('/status') ? { status: 'COMPLETED' } : body), {
            status: String(url).includes('/status') ? 200 : status,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    const provider = FalProvider.all('key').find((p) => p.key === 'fal:clarity-upscaler')!;
    const onSettled = vi.fn(async () => undefined);
    const result = provider.generate(
      { generationId: 'g', workspaceId: 'ws', capability: 'UPSCALE', params: { sourceKey: 'ws/image.jpg', factor: 2 }, files: {}, config: {} },
      {
        timeoutMs: 1000,
        signal: new AbortController().signal,
        onSettled,
        resume: { providerJobId: 'job-1', data: { statusUrl: 'https://queue.fal.run/status/job-1', responseUrl: 'https://queue.fal.run/result/job-1' } },
      },
    );
    await expect(result).rejects.toMatchObject(
      terminal ? { kind: 'REQUEST_REJECTED', meta: expect.objectContaining({ providerJobId: 'job-1' }) } : { meta: expect.objectContaining({ status }) },
    );
    if (terminal) expect(onSettled).toHaveBeenCalledWith('FAILED');
    else expect(onSettled).not.toHaveBeenCalled();
  });
});

describe('the exact Wan 2.5 request contract', () => {
  it("never exceeds Wan's published 1,500-character prompt limit", () => {
    const prompt = wanPrompt('p'.repeat(1_490), 'a long camera direction that would otherwise overflow');
    expect(prompt).toHaveLength(WAN_PROMPT_MAX);
    expect(prompt.startsWith('p'.repeat(1_490))).toBe(true);
  });

  it('omits the unsupported aspect_ratio field from the submitted body', async () => {
    let body: Record<string, unknown> | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL | Request, init: RequestInit = {}) => {
        body = JSON.parse(String(init.body)) as Record<string, unknown>;
        // Abort after observing the only request this test cares about; a
        // provider error is expected because there is no real queue to poll.
        return new Response(JSON.stringify({}), { status: 503, headers: { 'content-type': 'application/json' } });
      }),
    );
    const provider = FalProvider.all('key').find((p) => p.key === 'fal:wan-2.5-i2v')!;
    const input: ProviderInput = {
      generationId: 'g1',
      workspaceId: 'w1',
      capability: 'IMAGE_TO_VIDEO',
      params: {
        sourceKey: 'w1/source.png',
        prompt: 'make the product move',
        motion: 'slow push in',
        durationSec: 5,
        aspect: '1:1',
        audio: false,
        shots: 1,
        format: 'reveal',
      },
      files: { sourceKey: { url: 'https://example.test/source.png', mime: 'image/png' } },
      config: {},
    };

    await expect(provider.generate(input, { timeoutMs: 1_000, signal: new AbortController().signal })).rejects.toMatchObject({ kind: 'RETRYABLE' });
    expect(body).toMatchObject({
      image_url: 'https://example.test/source.png',
      prompt: 'make the product move. Camera: slow push in',
      duration: '5',
      resolution: '720p',
      enable_prompt_expansion: true,
    });
    expect(body).not.toHaveProperty('aspect_ratio');
  });

  it('resumes a persisted queue request without issuing a second POST', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
        calls.push({ url: String(url), method: init.method ?? (init.body ? 'POST' : 'GET') });
        if (String(url).includes('/status')) return new Response(JSON.stringify({ status: 'COMPLETED' }), { headers: { 'content-type': 'application/json' } });
        return new Response(JSON.stringify({ video: { url: 'https://cdn.fal/video.mp4', content_type: 'video/mp4' } }), {
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    const provider = FalProvider.all('key').find((p) => p.key === 'fal:wan-2.5-i2v')!;
    const source: ProviderInput = {
      generationId: 'g1',
      workspaceId: 'w1',
      capability: 'IMAGE_TO_VIDEO',
      params: { sourceKey: 'x', prompt: 'move', durationSec: 5, aspect: '9:16', audio: false, shots: 1, format: 'reveal' },
      files: { sourceKey: { url: 'https://source/image.png', mime: 'image/png' } },
      config: {},
    };
    const submitted = vi.fn(async () => undefined);
    const result = await provider.generate(source, {
      timeoutMs: 1_000,
      signal: new AbortController().signal,
      resume: { providerJobId: 'fal-1', data: { statusUrl: 'https://queue.fal.run/status/fal-1', responseUrl: 'https://queue.fal.run/result/fal-1' } },
      onSubmitted: submitted,
    });

    expect(result.providerJobId).toBe('fal-1');
    expect(submitted).not.toHaveBeenCalled();
    expect(calls).toEqual([
      { url: 'https://queue.fal.run/status/fal-1?logs=0', method: 'GET' },
      { url: 'https://queue.fal.run/result/fal-1', method: 'GET' },
    ]);
  });
});
