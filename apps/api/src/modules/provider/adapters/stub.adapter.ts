/**
 * The stub: every capability, no vendor.
 *
 * Registered outside production so the whole pipeline — routing, queueing,
 * heartbeats, storage, refunds, the studio's progress stream — can be run
 * and tested with no credential on the machine. Produces a real PNG, a real
 * MP4 (when ffmpeg is present) and real structured text, so downstream code
 * cannot tell it from a vendor.
 *
 * `config.behaviour` on the ProviderModel row makes it misbehave on
 * purpose: 'fail:RATE_LIMITED', 'slow:5000', 'hang'. That is how the
 * breaker, the fallback order and the sweeper get exercised. It has to be
 * the row: params are validated against the capability's schema, which
 * strips anything it does not know, so a marker in params never arrives.
 *
 * It reports no cost: the row's costPerCall stands in, as it does for any
 * vendor whose API does not say what a call cost.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { CAPABILITIES, ProviderError, type ProviderErrorKind, type ProviderInput, type ProviderOpts, type ProviderResult } from '@anystudio/shared';
import { BaseProvider } from './base';

const exec = promisify(execFile);

export class StubProvider extends BaseProvider {
  constructor() {
    super('stub:any', CAPABILITIES);
  }

  async generate(input: ProviderInput, opts: ProviderOpts): Promise<ProviderResult> {
    const behaviour = String(input.config.behaviour ?? 'ok');
    if (behaviour.startsWith('fail:')) {
      throw new ProviderError(behaviour.slice(5) as ProviderErrorKind, `stub asked to fail with ${behaviour.slice(5)}`, this.key);
    }
    if (behaviour.startsWith('slow:')) await new Promise((r) => setTimeout(r, Number(behaviour.slice(5))));
    if (behaviour === 'hang') await new Promise(() => undefined);

    opts.onProgress?.('stub working', 50);
    const jobId = `stub-${input.generationId.slice(0, 8)}`;

    switch (input.capability) {
      case 'TEXT_GENERATE':
        return { providerKey: this.key, providerJobId: jobId, artifacts: [{ mime: 'application/json', role: 'text', text: stubText(input) }] };
      case 'IMAGE_TO_VIDEO':
      case 'VIDEO_STITCH':
      case 'DUB':
      case 'LIPSYNC':
        return { providerKey: this.key, providerJobId: jobId, artifacts: [await stubVideo(input.capability)] };
      case 'VOICEOVER':
      case 'MUSIC':
        return { providerKey: this.key, providerJobId: jobId, artifacts: [await stubAudio()] };
      default:
        return { providerKey: this.key, providerJobId: jobId, artifacts: [await stubImage(input.capability)] };
    }
  }
}

async function stubImage(label: string) {
  const bytes = await sharp({ create: { width: 1024, height: 1024, channels: 4, background: { r: 214, g: 0, b: 110, alpha: 1 } } })
    .composite([{ input: Buffer.from(`<svg width="1024" height="1024"><text x="48" y="120" font-size="64" font-family="sans-serif" fill="white">stub · ${label}</text></svg>`), top: 0, left: 0 }])
    .png()
    .toBuffer();
  return { bytes: new Uint8Array(bytes), mime: 'image/png', role: 'image' as const, width: 1024, height: 1024 };
}

async function stubVideo(label: string) {
  try {
    const { stdout } = await exec('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=0xD6006E:s=720x1280:d=2', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
    return { bytes: new Uint8Array(stdout), mime: 'video/mp4', role: 'video' as const, width: 720, height: 1280, durationMs: 2000 };
  } catch (err) {
    throw new ProviderError('PROVIDER_DOWN', `stub video needs ffmpeg for ${label}: ${err instanceof Error ? err.message : err}`, 'stub:any');
  }
}

async function stubAudio() {
  try {
    const { stdout } = await exec('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:a', 'libmp3lame', '-f', 'mp3', 'pipe:1'], { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 });
    return { bytes: new Uint8Array(stdout), mime: 'audio/mpeg', role: 'audio' as const, durationMs: 2000 };
  } catch (err) {
    throw new ProviderError('PROVIDER_DOWN', `stub audio needs ffmpeg: ${err instanceof Error ? err.message : err}`, 'stub:any');
  }
}

/** The shape the pipeline asked for: copy, a shot plan, or one field. */
function stubText(input: ProviderInput) {
  const task = (input.params as { task?: string }).task;
  if (task === 'shot_plan') {
    return {
      hook: 'Stub: the hook',
      shots: [
        { prompt: 'Stub shot one: the product on a table', motion: 'slow push-in', durationSec: 8, caption: 'Made for you' },
        { prompt: 'Stub shot two: the product in hand', motion: 'orbit', durationSec: 8, caption: 'Every day' },
        { prompt: 'Stub shot three: the product close', motion: 'tilt up', durationSec: 8, caption: 'Built to last' },
        { prompt: 'Stub shot four: the product settled', motion: 'hold', durationSec: 5, caption: 'Order today' },
      ],
      endCard: { text: 'Stub end card', price: (input.params as { price?: string }).price },
      music: { mood: 'joyful', tempo: 'mid' },
    };
  }
  if (task === 'field') return { value: `Stub rewrite of ${(input.params as { field?: string }).field ?? 'a field'}` };
  return stubCopy(input);
}

function stubCopy(input: ProviderInput) {
  const p = input.params as { productName?: string; price?: string; platforms?: string[] };
  const name = p.productName ?? 'Your product';
  return {
    description: { long: `${name} — a stub description written by no model at all.`, short: `${name}, stubbed.`, bullets: ['Stub bullet one', 'Stub bullet two'], specs: [] },
    captions: Object.fromEntries((p.platforms ?? ['instagram']).map((pl) => [pl, `${name} ${p.price ? `· ${p.price}` : ''} #stub`])),
    hashtags: { broad: ['#stub'], niche: [], local: [] },
    altText: `${name} on a plain background`,
    seo: { title: name, metaDescription: `${name} — stub`, keywords: [name.toLowerCase()] },
  };
}
