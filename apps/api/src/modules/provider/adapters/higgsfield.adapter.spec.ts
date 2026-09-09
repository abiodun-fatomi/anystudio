import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderInput } from '@anystudio/shared';
import { HiggsfieldProvider } from './higgsfield.adapter';

afterEach(() => vi.unstubAllGlobals());

describe('Higgsfield durable jobs', () => {
  it('resumes a recorded request id without submitting another render', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
        calls.push({ url: String(url), method: init.method ?? (init.body ? 'POST' : 'GET') });
        expect(init.headers).toMatchObject({ Authorization: 'Key key:secret' });
        return new Response(JSON.stringify({ status: 'completed', video: { url: 'https://cdn.higgsfield/video.mp4' } }), {
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    const provider = HiggsfieldProvider.all('key', 'secret').find((p) => p.key === 'higgsfield:dop-turbo')!;
    const input: ProviderInput = {
      generationId: 'g1',
      workspaceId: 'w1',
      capability: 'IMAGE_TO_VIDEO',
      params: { sourceKey: 'x', prompt: 'move', durationSec: 5, aspect: '9:16', audio: false, shots: 1, format: 'reveal' },
      files: { sourceKey: { url: 'https://source/image.png', mime: 'image/png' } },
      config: {},
    };
    const onSubmitted = vi.fn(async () => undefined);
    const result = await provider.generate(input, {
      timeoutMs: 1_000,
      signal: new AbortController().signal,
      resume: { providerJobId: 'hf-saved' },
      onSubmitted,
    });

    expect(result.providerJobId).toBe('hf-saved');
    expect(onSubmitted).not.toHaveBeenCalled();
    expect(calls).toEqual([{ url: 'https://api.higgsfield.ai/requests/hf-saved/status', method: 'GET' }]);
  });
});

const input: ProviderInput = {
  generationId: 'g1',
  workspaceId: 'w1',
  capability: 'IMAGE_TO_VIDEO',
  params: {
    sourceKey: 'x',
    prompt: 'Keep the bottle intact',
    motion: 'slow push in',
    durationSec: 5,
    aspect: '9:16',
    audio: false,
    shots: 1,
    format: 'reveal',
  },
  files: { sourceKey: { url: 'https://source/image.png', mime: 'image/png' } },
  config: {},
};
const provider = () => HiggsfieldProvider.all('key', 'secret')[0]!;
const opts = () => ({
  timeoutMs: 1_000,
  signal: new AbortController().signal,
  onSubmitted: vi.fn(async () => undefined),
  onSettled: vi.fn(async () => undefined),
});
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('Higgsfield current API contract', () => {
  it.each([{}, { baseUrl: 'https://platform.higgsfield.ai/v1/', endpoint: 'image2video' }])(
    'submits the documented DoP payload and persists before polling (%j)',
    async (config) => {
      const options = opts();
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(response({ request_id: 'hf-new', status: 'queued', status_url: 'https://untrusted.example/status' }))
        .mockImplementationOnce(async () => {
          expect(options.onSubmitted).toHaveBeenCalledWith('hf-new');
          return response({ request_id: 'hf-new', status: 'completed', video: { url: 'https://cdn.higgsfield/video.mp4' } });
        });
      vi.stubGlobal('fetch', fetch);
      const result = await provider().generate({ ...input, config }, options);
      expect(fetch.mock.calls[0]![0]).toBe('https://api.higgsfield.ai/higgsfield-ai/dop/turbo');
      const init = fetch.mock.calls[0]![1] as RequestInit;
      expect(init.headers).toMatchObject({ Authorization: 'Key key:secret' });
      expect(init.headers).not.toHaveProperty('hf-api-secret');
      expect(JSON.parse(init.body as string)).toEqual({
        prompt: 'Keep the bottle intact. Camera: slow push in',
        image_url: 'https://source/image.png',
        enhance_prompt: true,
      });
      expect(fetch.mock.calls[1]![0]).toBe('https://api.higgsfield.ai/requests/hf-new/status');
      expect(result.artifacts[0]).toEqual({ url: 'https://cdn.higgsfield/video.mp4', mime: 'video/mp4', role: 'video' });
    },
  );

  it.each([{}, null, { id: 'old-id' }, { request_id: '' }])('blocks duplicate submissions when a successful response lacks request_id (%j)', async (body) => {
    const fetch = vi.fn().mockResolvedValue(response(body));
    vi.stubGlobal('fetch', fetch);
    await expect(provider().generate(input, opts())).rejects.toMatchObject({ kind: 'SUBMISSION_UNKNOWN' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['failed', 'RETRYABLE'],
    ['nsfw', 'CONTENT_REJECTED'],
    ['canceled', 'RETRYABLE'],
  ] as const)('settles terminal %s without polling forever', async (status, kind) => {
    const fetch = vi.fn().mockResolvedValue(response({ request_id: 'saved', status }));
    vi.stubGlobal('fetch', fetch);
    const options = opts();
    await expect(provider().generate(input, { ...options, resume: { providerJobId: 'saved' } })).rejects.toMatchObject({ kind });
    expect(options.onSettled).toHaveBeenCalledWith('FAILED');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('settles a completed request with no output', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ status: 'completed' })));
    const options = opts();
    await expect(provider().generate(input, { ...options, resume: { providerJobId: 'saved' } })).rejects.toThrow('completed without a video url');
    expect(options.onSettled).toHaveBeenCalledWith('FAILED');
  });

  it('does not send an unverified Kling model through the DoP schema', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(HiggsfieldProvider.all('key', 'secret')[1]!.generate(input, opts())).rejects.toMatchObject({ kind: 'PROVIDER_DOWN' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not retry an authentication rejection', async () => {
    const fetch = vi.fn().mockResolvedValue(response({ detail: 'Invalid credentials' }, 401));
    vi.stubGlobal('fetch', fetch);
    await expect(provider().generate(input, opts())).rejects.toMatchObject({ kind: 'PROVIDER_DOWN' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
