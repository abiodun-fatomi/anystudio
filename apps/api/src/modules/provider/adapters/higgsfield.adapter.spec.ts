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
        return new Response(JSON.stringify({ status: 'completed', results: { raw: { url: 'https://cdn.higgsfield/video.mp4' } } }), {
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
    expect(calls).toEqual([{ url: 'https://platform.higgsfield.ai/v1/requests/hf-saved', method: 'GET' }]);
  });
});
