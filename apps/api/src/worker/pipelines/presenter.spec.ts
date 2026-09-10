import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { renderPresenter, wantsPresenter } from './presenter';
import type { PipelineContext } from './index';
import { HAS_FFMPEG } from '../../test/ffmpeg';

/** These make real audio and read real durations; without ffmpeg there is nothing to make it with. */
const ffIt = HAS_FFMPEG ? it : it.skip;
afterEach(() => vi.restoreAllMocks());

const exec = promisify(execFile);

async function tone(seconds: number): Promise<Uint8Array> {
  const { stdout } = await exec(
    'ffmpeg',
    ['-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, '-c:a', 'libmp3lame', '-b:a', '64k', '-f', 'mp3', 'pipe:1'],
    { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 },
  );
  return new Uint8Array(stdout);
}

function ctxWith(opts: { lab: object | null; voice?: object | null; audio: Uint8Array }) {
  const put = vi.fn(async (input: { workspaceId: string; generationId: string; name: string }) => {
    return `${input.workspaceId}/2026/09/gen/${input.generationId}/work/${input.name}`;
  });
  const callCapability = vi.fn(async () => ({
    providerKey: 'elevenlabs:tts',
    artifacts: [{ role: 'audio', mime: 'audio/mpeg', bytes: opts.audio }],
    costMinor: 5,
  }));
  const callExternal = vi.fn(async (_provider, _input, execute: (opts: object) => Promise<unknown>, externalOpts: object) => execute(externalOpts));
  const ctx = {
    row: { id: 'gen-1', workspaceId: 'ws-1', createdAt: new Date('2026-09-06T00:00:00Z'), input: {} },
    db: {
      voiceProfile: { findUnique: vi.fn(async () => opts.voice ?? null) },
    },
    media: {
      putGenerationWork: put,
      signRead: vi.fn(async (k: string) => `https://signed/${k}`),
      requireReady: vi.fn(async (_ws: string, key: string) => ({ key, mime: 'image/jpeg' })),
      getBytes: vi.fn(async () => Buffer.from('jpegbytes')),
    },
    presenterLab: () => opts.lab,
    callCapability,
    callExternal,
    stage: vi.fn(async () => undefined),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    signal: new AbortController().signal,
    budgetMs: 480_000,
  } as unknown as PipelineContext;
  return { ctx, put, callCapability, callExternal };
}

const base = {
  sourceKey: 'ws-1/photo.jpg',
  prompt: 'x',
  shots: 4 as const,
  format: 'ugc' as const,
  aspect: '9:16' as const,
  durationSec: 8 as const,
  audio: false,
};

describe('a presenter on camera', () => {
  it('only for a customer-filmed ad of two shots or more', () => {
    expect(wantsPresenter({ ...base, presenter: { kind: 'stock', key: 'daphne' } })).toBe(true);
    expect(wantsPresenter({ ...base, shots: 1, presenter: { kind: 'stock', key: 'daphne' } })).toBe(false);
    expect(wantsPresenter({ ...base, format: 'reveal', presenter: { kind: 'stock', key: 'daphne' } })).toBe(false);
    expect(wantsPresenter(base)).toBe(false);
  });

  ffIt('records the script in the chosen voice, films the stock look with that audio, and stores both', async () => {
    const audio = await tone(3);
    const lab = {
      key: 'heygen:translate',
      capabilities: ['DUB'],
      talkingVideo: vi.fn(async () => ({ url: 'https://vendor/clip.mp4', providerJobId: 'hg-1' })),
      presenterCostMinor: (s: number) => Math.ceil(s / 60) * 100,
    };
    const voice = {
      key: 'mine:abc',
      active: true,
      kind: 'CLONE',
      workspaceId: 'ws-1',
      providerKey: 'elevenlabs:tts',
      providerVoiceId: 'v1',
      language: 'en-NG',
    };
    const { ctx, put, callCapability, callExternal } = ctxWith({ lab, voice, audio });
    vi.spyOn(await import('../../modules/provider/adapters/http'), 'fetchBytes').mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3, 4]),
      mime: 'video/mp4',
    } as never);
    const out = await renderPresenter(
      ctx,
      { ...base, presenter: { kind: 'stock', key: 'daphne', voiceId: 'mine:abc' } },
      'I bought this last week and I love it.',
    );
    expect(callCapability).toHaveBeenCalledWith(
      'VOICEOVER',
      expect.objectContaining({ params: expect.objectContaining({ providerVoiceId: 'v1', language: 'en' }) }),
      expect.objectContaining({ route: { only: 'elevenlabs:tts' } }),
    );
    expect(lab.talkingVideo).toHaveBeenCalledWith(
      expect.objectContaining({ avatarId: 'Daphne_public_4', aspect: '9:16', audioUrl: expect.stringMatching(/^https:\/\/signed\//) }),
      expect.anything(),
    );
    expect(callExternal).toHaveBeenCalledWith(
      lab,
      expect.objectContaining({ params: expect.objectContaining({ operation: 'presenter-video' }) }),
      expect.any(Function),
      expect.objectContaining({ timeoutMs: 480_000 }),
    );
    expect(out.clip.durationMs).toBeGreaterThan(2500);
    expect(out.clip.key).toMatch(/gen\/gen-1\/work\/presenter\.mp4$/);
    expect(out.clip.audioKey).toMatch(/presenter\.mp3$/);
    expect(put).toHaveBeenCalledTimes(2);
    expect(out.costMinor).toBe(105);
  });

  ffIt('refuses another workspace’s voice, a photo without consent, and an unknown presenter', async () => {
    const audio = await tone(1);
    const lab = { key: 'heygen:translate', capabilities: ['DUB'], talkingVideo: vi.fn(), presenterCostMinor: () => 0 };
    const other = { key: 'mine:x', active: true, kind: 'CLONE', workspaceId: 'ws-2', providerKey: 'elevenlabs:tts', providerVoiceId: 'v', language: 'en' };
    await expect(
      renderPresenter(ctxWith({ lab, voice: other, audio }).ctx, { ...base, presenter: { kind: 'stock', key: 'daphne', voiceId: 'mine:x' } }, 'hi'),
    ).rejects.toMatchObject({ kind: 'INVALID_INPUT' });
    await expect(renderPresenter(ctxWith({ lab, audio }).ctx, { ...base, presenter: { kind: 'photo', photoKey: 'ws-1/me.jpg' } }, 'hi')).rejects.toMatchObject({
      kind: 'INVALID_INPUT',
    });
    await expect(renderPresenter(ctxWith({ lab, audio }).ctx, { ...base, presenter: { kind: 'stock', key: 'nobody' } }, 'hi')).rejects.toMatchObject({
      kind: 'INVALID_INPUT',
    });
    await expect(renderPresenter(ctxWith({ lab: null, audio }).ctx, { ...base, presenter: { kind: 'stock', key: 'daphne' } }, 'hi')).rejects.toMatchObject({
      kind: 'PROVIDER_DOWN',
    });
  });
});
