import { describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderError } from '@anystudio/shared';
import { mix, singInMyVoice } from './my-voice';
import type { PipelineContext } from './index';

const exec = promisify(execFile);

/** A short MP3 tone, for the mixer. */
async function tone(hz: number, seconds = 2): Promise<Uint8Array> {
  const { stdout } = await exec(
    'ffmpeg',
    ['-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=${seconds}`, '-c:a', 'libmp3lame', '-b:a', '64k', '-f', 'mp3', 'pipe:1'],
    { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 },
  );
  return new Uint8Array(stdout);
}

function ctxWith(voiceRow: object | null, lab: object | null): PipelineContext {
  return {
    row: { id: 'gen-1', workspaceId: 'ws-1', input: {} } as PipelineContext['row'],
    db: { voiceProfile: { findUnique: vi.fn(async () => voiceRow) } } as unknown as PipelineContext['db'],
    voiceLab: () => lab as never,
    stage: vi.fn(async () => undefined),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as PipelineContext['log'],
    signal: new AbortController().signal,
    budgetMs: 600_000,
  } as unknown as PipelineContext;
}

const mine = { key: 'mine:abc', active: true, kind: 'CLONE', workspaceId: 'ws-1', providerKey: 'elevenlabs:tts', providerVoiceId: 'v1' };
const song = { bytes: new Uint8Array(4000), mime: 'audio/mpeg', ext: 'mp3', seconds: 90 };

describe('singing in their own voice', () => {
  it('refuses a voice that is not this workspace’s own (a refund, not a fallback)', async () => {
    const ctx = ctxWith({ ...mine, workspaceId: 'ws-2' }, null);
    await expect(singInMyVoice(ctx, { singer: 'me', voiceId: 'mine:abc' } as never, song)).rejects.toMatchObject({ kind: 'INVALID_INPUT' });
  });

  it('keeps the model singer, and says so, when the vendor is not configured', async () => {
    const out = await singInMyVoice(ctxWith(mine, null), { singer: 'me', voiceId: 'mine:abc' } as never, song);
    expect(out.applied).toBe(false);
    expect(out.bytes).toBe(song.bytes);
    expect(out.note).toMatch(/studio voice/);
  });

  it('keeps the model singer when the stems split fails, charging nothing', async () => {
    const lab = {
      separateStems: vi.fn(async () => {
        throw new ProviderError('RETRYABLE', 'boom', 'elevenlabs:tts');
      }),
      voiceLabCostMinor: () => 10,
    };
    const out = await singInMyVoice(ctxWith(mine, lab), { singer: 'me', voiceId: 'mine:abc' } as never, song);
    expect(out.applied).toBe(false);
    expect(out.costMinor).toBe(0);
    expect(out.reason).toMatch(/stems/);
  });

  it('mixes the converted vocal over the instrumental when every step works', async () => {
    const [inst, voc] = await Promise.all([tone(220), tone(880)]);
    const lab = {
      separateStems: vi.fn(async () => ({ vocals: voc, instrumental: inst, mime: 'audio/mpeg' })),
      convertVoice: vi.fn(async () => ({ bytes: voc, mime: 'audio/mpeg' })),
      voiceLabCostMinor: (step: string) => (step === 'stems' ? 20 : 180),
    };
    const out = await singInMyVoice(ctxWith(mine, lab), { singer: 'me', voiceId: 'mine:abc', language: 'en' } as never, song);
    expect(out.applied).toBe(true);
    expect(out.costMinor).toBe(200);
    expect(out.bytes.byteLength).toBeGreaterThan(1000);
    expect(lab.convertVoice).toHaveBeenCalledWith('v1', expect.objectContaining({ filename: 'vocals.mp3' }), expect.anything());
  });
});

describe('mix', () => {
  it('produces an MP3 as long as the instrumental', async () => {
    const [inst, voc] = await Promise.all([tone(220, 3), tone(880, 1)]);
    const out = await mix(inst, voc);
    expect(out.byteLength).toBeGreaterThan(1000);
    const file = join(tmpdir(), `mix-${process.pid}.mp3`);
    await writeFile(file, out);
    const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]);
    await rm(file, { force: true });
    expect(parseFloat(stdout.trim())).toBeGreaterThan(2.8);
    expect(parseFloat(stdout.trim())).toBeLessThan(3.3);
  });
});
