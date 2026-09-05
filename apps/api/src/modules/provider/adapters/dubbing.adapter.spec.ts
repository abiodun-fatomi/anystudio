/**
 * The dubbing and lip-sync adapters against a scripted fetch: what each
 * one sends, how it reads the vendor's job states, and how a vendor's
 * refusal is classified. No network.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderInput } from '@anystudio/shared';
import { ProviderError } from '@anystudio/shared';
import { ElevenLabsProvider, classifyDubError } from './elevenlabs.adapter';
import { HeyGenProvider, classifyFailure } from './heygen.adapter';
import { SyncProvider } from './sync.adapter';

type Call = { url: string; init: RequestInit };
function script(responses: Array<(call: Call) => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    const call = { url: String(url), init };
    calls.push(call);
    const next = responses.shift();
    if (!next) throw new Error(`unexpected call to ${call.url}`);
    return next(call);
  });
  vi.stubGlobal('fetch', fetch);
  return calls;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const bytes = (n: number, type: string) => new Response(new Uint8Array(n).fill(7), { status: 200, headers: { 'content-type': type } });
const opts = () => ({ timeoutMs: 60_000, signal: new AbortController().signal, onProgress: vi.fn() });

function dubInput(params: Record<string, unknown>, files: ProviderInput['files'] = { sourceKey: { url: 'https://r2.example/v.mp4', mime: 'video/mp4' } }): ProviderInput {
  return { generationId: 'g1', workspaceId: 'w1', capability: 'DUB', params: { sourceKey: 'w1/2026/09/uploads/v.mp4', targetLanguage: 'fr', sourceLanguage: 'auto', lipsync: false, speakers: 0, keepBackground: true, quality: 'speed', consent: true, ...params }, files, config: {} };
}

afterEach(() => vi.unstubAllGlobals());

describe('ElevenLabs dubbing', () => {
  it('submits by URL as a form, polls until dubbed, downloads the MP4, and says the lips were not touched', async () => {
    const calls = script([
      () => json({ dubbing_id: 'dub_1', expected_duration_sec: 40 }),
      () => json({ dubbing_id: 'dub_1', status: 'dubbing' }),
      () => json({ dubbing_id: 'dub_1', status: 'dubbed', target_languages: ['fr'] }),
      () => bytes(4000, 'video/mp4'),
    ]);
    const p = ElevenLabsProvider.all('k').find((x) => x.key === 'elevenlabs:dubbing-v1')!;
    const o = opts();
    const promise = p.generate(dubInput({ speakers: 2, keepBackground: false }), o);
    // The poll waits eight seconds between checks; jump the clock rather than the test.
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    await vi.runAllTimersAsync().catch(() => undefined);
    vi.useRealTimers();
    const r = await promise;

    expect(calls[0]!.url).toBe('https://api.elevenlabs.io/v1/dubbing');
    const form = calls[0]!.init.body as FormData;
    expect(form.get('source_url')).toBe('https://r2.example/v.mp4');
    expect(form.get('target_lang')).toBe('fr');
    expect(form.get('source_lang')).toBe('auto');
    expect(form.get('num_speakers')).toBe('2');
    expect(form.get('drop_background_audio')).toBe('true');
    expect((calls[0]!.init.headers as Record<string, string>)['xi-api-key']).toBe('k');
    expect(calls[3]!.url).toBe('https://api.elevenlabs.io/v1/dubbing/dub_1/audio/fr');
    expect(r.providerJobId).toBe('dub_1');
    expect(r.artifacts[0]).toMatchObject({ role: 'video', mime: 'video/mp4' });
    expect(r.meta?.lipsync).toBe(false);
  });

  it('refuses a language it does not speak before spending anything', async () => {
    const calls = script([]);
    const p = ElevenLabsProvider.all('k').find((x) => x.key === 'elevenlabs:dubbing-v1')!;
    await expect(p.generate(dubInput({ targetLanguage: 'en-NG' }), opts())).rejects.toMatchObject({ kind: 'INVALID_INPUT' });
    expect(calls).toHaveLength(0);
  });

  it('reads a failed dub and classifies the reason', async () => {
    script([
      () => json({ dubbing_id: 'dub_2', expected_duration_sec: 10 }),
      () => json({ dubbing_id: 'dub_2', status: 'failed', error: 'Content moderation: prohibited content' }),
    ]);
    const p = ElevenLabsProvider.all('k').find((x) => x.key === 'elevenlabs:dubbing-v1')!;
    await expect(p.generate(dubInput({}), opts())).rejects.toMatchObject({ kind: 'CONTENT_REJECTED' });
    expect(classifyDubError('No speech detected in the file')).toBe('INVALID_INPUT');
    expect(classifyDubError('internal error')).toBe('RETRYABLE');
    expect(classifyDubError(null)).toBe('RETRYABLE');
  });
});

describe('HeyGen v3', () => {
  it('translates with the language name, audio only unless lips are wanted, and reads a wrapped status', async () => {
    const calls = script([
      () => json({ data: { video_translation_ids: ['vt_1'] } }),
      () => json({ data: { id: 'vt_1', status: 'running' } }),
      () => json({ data: { id: 'vt_1', status: 'completed', video_url: 'https://cdn.heygen/vt_1.mp4' } }),
    ]);
    const p = HeyGenProvider.all('hk').find((x) => x.key === 'heygen:translate')!;
    const promise = p.generate(dubInput({ targetLanguage: 'en-NG', lipsync: true, quality: 'precision', sourceLanguage: 'en', speakers: 1 }), opts());
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    await vi.runAllTimersAsync().catch(() => undefined);
    vi.useRealTimers();
    const r = await promise;

    expect(calls[0]!.url).toBe('https://api.heygen.com/v3/video-translations');
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(body.output_languages).toEqual(['English (Nigeria)']);
    expect(body.translate_audio_only).toBe(false);
    expect(body.mode).toBe('precision');
    expect(body.input_language).toBe('en');
    expect(body.speaker_num).toBe(1);
    expect(body.video).toEqual({ type: 'url', url: 'https://r2.example/v.mp4' });
    expect((calls[0]!.init.headers as Record<string, string>)['x-api-key']).toBe('hk');
    expect(calls[2]!.url).toBe('https://api.heygen.com/v3/video-translations/vt_1');
    expect(r.artifacts[0]).toMatchObject({ role: 'video', url: 'https://cdn.heygen/vt_1.mp4' });
    expect(r.meta?.lipsync).toBe(true);
  });

  it('lip-syncs audio onto a video and surfaces a failure message', async () => {
    script([
      () => json({ data: { lipsync_id: 'ls_1' } }),
      () => json({ id: 'ls_1', status: 'failed', failure_message: 'No face detected in the video' }),
    ]);
    const p = HeyGenProvider.all('hk').find((x) => x.key === 'heygen:lipsync')!;
    const input: ProviderInput = { generationId: 'g2', workspaceId: 'w1', capability: 'LIPSYNC', params: { sourceKey: 'a', audioKey: 'b', language: 'en', quality: 'speed', consent: true }, files: { sourceKey: { url: 'https://r2/v.mp4', mime: 'video/mp4' }, audioKey: { url: 'https://r2/a.mp3', mime: 'audio/mpeg' } }, config: {} };
    await expect(p.generate(input, opts())).rejects.toMatchObject({ kind: 'INVALID_INPUT' });
    expect(classifyFailure('Policy violation')).toBe('CONTENT_REJECTED');
    expect(classifyFailure(undefined)).toBe('RETRYABLE');
  });
});

describe('sync.so', () => {
  it('sends the two inputs, polls, and treats REJECTED as the content\'s fault', async () => {
    const calls = script([
      () => json({ id: 'sy_1', status: 'PENDING' }, 201),
      () => json({ id: 'sy_1', status: 'PROCESSING' }),
      () => json({ id: 'sy_1', status: 'COMPLETED', outputUrl: 'https://out/sy_1.mp4' }),
      () => json({ id: 'sy_2', status: 'PENDING' }, 201),
      () => json({ id: 'sy_2', status: 'REJECTED', error: 'face not allowed' }),
    ]);
    const p = SyncProvider.all('sk')[0]!;
    const input: ProviderInput = { generationId: 'g3', workspaceId: 'w1', capability: 'LIPSYNC', params: { sourceKey: 'a', audioKey: 'b', language: 'en', quality: 'precision', consent: true }, files: { sourceKey: { url: 'https://r2/v.mp4', mime: 'video/mp4' }, audioKey: { url: 'https://r2/a.mp3', mime: 'audio/mpeg' } }, config: {} };
    const promise = p.generate(input, opts());
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    await vi.runAllTimersAsync().catch(() => undefined);
    vi.useRealTimers();
    const r = await promise;
    const body = JSON.parse(String(calls[0]!.init.body)) as { model: string; input: Array<{ type: string; url: string }> };
    expect(body.model).toBe('lipsync-2-pro');
    expect(body.input).toEqual([{ type: 'video', url: 'https://r2/v.mp4' }, { type: 'audio', url: 'https://r2/a.mp3' }]);
    expect(r.artifacts[0]).toMatchObject({ role: 'video', url: 'https://out/sy_1.mp4' });

    const rejected = p.generate(input, opts()).then(() => 'resolved', (e: unknown) => (e instanceof ProviderError ? e.kind : 'other'));
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    await vi.runAllTimersAsync().catch(() => undefined);
    vi.useRealTimers();
    expect(await rejected).toBe('CONTENT_REJECTED');
  });
});
