import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAiProvider, SORA_API_SHUTDOWN_AT, soraApiAvailable, soraSize } from './openai.adapter';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Sora output orientation', () => {
  it('uses landscape for a landscape request instead of a seeded portrait default', () => {
    expect(soraSize('16:9')).toBe('1280x720');
  });

  it('uses portrait for vertical aspect ratios', () => {
    expect(soraSize('9:16')).toBe('720x1280');
    expect(soraSize('4:5')).toBe('720x1280');
  });
});

describe('Sora API retirement', () => {
  it('registers Sora before the official shutdown but not at or after it', () => {
    expect(soraApiAvailable(SORA_API_SHUTDOWN_AT - 1)).toBe(true);
    expect(soraApiAvailable(SORA_API_SHUTDOWN_AT)).toBe(false);
    expect(OpenAiProvider.all('key', SORA_API_SHUTDOWN_AT - 1).map((p) => p.key)).toContain('openai:sora-2');
    expect(OpenAiProvider.all('key', SORA_API_SHUTDOWN_AT).map((p) => p.key)).not.toContain('openai:sora-2');
  });

  it('keeps the supported TTS adapter after the video API shuts down', () => {
    expect(OpenAiProvider.all('key', SORA_API_SHUTDOWN_AT).map((p) => p.key)).toEqual(['openai:tts']);
  });

  it('fails locally after shutdown even when a long-lived worker registered the adapter earlier', async () => {
    const sora = OpenAiProvider.all('key', SORA_API_SHUTDOWN_AT - 1).find((p) => p.key === 'openai:sora-2')!;
    vi.useFakeTimers();
    vi.setSystemTime(SORA_API_SHUTDOWN_AT);
    await expect(
      sora.generate(
        {
          generationId: 'g1',
          workspaceId: 'w1',
          capability: 'IMAGE_TO_VIDEO',
          params: { sourceKey: 'source', prompt: 'move', motion: 'pan', durationSec: 5, aspect: '16:9', shots: 1 },
          files: { sourceKey: { url: 'https://example.test/source.png', mime: 'image/png' } },
          config: {},
        },
        { timeoutMs: 1_000, signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ kind: 'PROVIDER_DOWN' });
  });

  it('resumes a persisted video id without creating a second Sora job', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(SORA_API_SHUTDOWN_AT - 1);
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request) => {
        calls.push(String(url));
        if (String(url).endsWith('/content')) return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'video/mp4' } });
        return new Response(JSON.stringify({ id: 'video_saved', status: 'completed', progress: 100 }), {
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    const sora = OpenAiProvider.all('key', SORA_API_SHUTDOWN_AT - 1).find((p) => p.key === 'openai:sora-2')!;
    const onSubmitted = vi.fn(async () => undefined);
    const result = await sora.generate(
      {
        generationId: 'g1',
        workspaceId: 'w1',
        capability: 'IMAGE_TO_VIDEO',
        params: { sourceKey: 'source', prompt: 'move', motion: 'pan', durationSec: 5, aspect: '16:9', shots: 1 },
        files: { sourceKey: { url: 'https://example.test/source.png', mime: 'image/png' } },
        config: {},
      },
      { timeoutMs: 1_000, signal: new AbortController().signal, resume: { providerJobId: 'video_saved' }, onSubmitted },
    );

    expect(result.providerJobId).toBe('video_saved');
    expect(onSubmitted).not.toHaveBeenCalled();
    expect(calls).toEqual(['https://api.openai.com/v1/videos/video_saved', 'https://api.openai.com/v1/videos/video_saved/content']);
  });
});
