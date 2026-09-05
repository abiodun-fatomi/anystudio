/**
 * fal.ai — the primary aggregator.
 *
 * One adapter class, many keys: every fal endpoint we route to is its own
 * instance with its own key ("fal:seedream-4.5-edit"), so a ProviderModel
 * row maps to exactly one endpoint and the router can demote one without
 * touching the others. The endpoint path comes from the row's `config`, so a
 * model version bump is an UPDATE, not a deploy.
 *
 * Every fal model speaks the same queue protocol:
 *   POST https://queue.fal.run/{endpoint}         → { request_id, status_url, response_url }
 *   GET  {status_url}                              → { status: IN_QUEUE | IN_PROGRESS | COMPLETED }
 *   GET  {response_url}                            → the model's output
 * Only the input and output shapes differ per model, and those are the two
 * small functions at the bottom of this file.
 *
 * Endpoint paths and field names were taken from fal's model pages in
 * September 2026. They change; when one does, fix the row's config first
 * and this file second.
 */

import { ProviderError, type Capability, type ProviderArtifact, type ProviderInput, type ProviderOpts, type ProviderResult } from '@anystudio/shared';
import { BaseProvider } from './base';
import { http, pick, poll } from './http';

interface FalSubmit { request_id: string; status_url: string; response_url: string }
interface FalStatus { status: 'IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED'; queue_position?: number; logs?: Array<{ message: string }> }

const QUEUE = 'https://queue.fal.run';

/** The endpoints we know how to shape input for, with their default paths. */
const KNOWN: Record<string, { capability: Capability; endpoint: string }> = {
  'fal:seedream-4.5-edit': { capability: 'IMAGE_EDIT', endpoint: 'fal-ai/bytedance/seedream/v4.5/edit' },
  'fal:flux-2-pro': { capability: 'IMAGE_GENERATE', endpoint: 'fal-ai/flux-2-pro' },
  'fal:bria-rmbg-2': { capability: 'BACKGROUND_REMOVE', endpoint: 'fal-ai/bria/background/remove' },
  'fal:clarity-upscaler': { capability: 'UPSCALE', endpoint: 'fal-ai/clarity-upscaler' },
  'fal:wan-2.5-i2v': { capability: 'IMAGE_TO_VIDEO', endpoint: 'fal-ai/wan-25-preview/image-to-video' },
  'fal:minimax-music-v2': { capability: 'MUSIC', endpoint: 'fal-ai/minimax-music/v2' },
};

export class FalProvider extends BaseProvider {
  static all(apiKey: string): FalProvider[] {
    return Object.entries(KNOWN).map(([key, k]) => new FalProvider(apiKey, key, k.capability, k.endpoint));
  }

  constructor(
    private readonly apiKey: string,
    key: string,
    capability: Capability,
    private readonly defaultEndpoint: string,
  ) {
    super(key, [capability]);
  }

  async generate(input: ProviderInput, opts: ProviderOpts): Promise<ProviderResult> {
    const endpoint = this.str(input.config, 'endpoint', this.defaultEndpoint);
    const headers = { authorization: `Key ${this.apiKey}` };
    const body = this.shapeInput(input);

    const submitted = await http<FalSubmit>(this.key, `${QUEUE}/${endpoint}`, { body, headers, timeoutMs: 30_000, signal: opts.signal });
    const { request_id: providerJobId, status_url, response_url } = submitted.json;
    opts.onProgress?.('queued at fal', 10);

    const started = Date.now();
    await poll(
      async () => {
        const s = await http<FalStatus>(this.key, `${status_url}?logs=0`, { headers, timeoutMs: 15_000, signal: opts.signal });
        if (s.json.status === 'COMPLETED') return true;
        if (s.json.status === 'IN_PROGRESS') opts.onProgress?.('fal is generating', 40);
        else if (s.json.queue_position !== undefined) opts.onProgress?.(`waiting in queue (position ${s.json.queue_position})`, 15);
        return null;
      },
      { intervalMs: input.capability === 'IMAGE_TO_VIDEO' ? 5_000 : 1_500, timeoutMs: opts.timeoutMs, signal: opts.signal },
    ).catch((err) => {
      throw err instanceof ProviderError ? err : new ProviderError('RETRYABLE', `${this.key}: ${err instanceof Error ? err.message : err}`, this.key, { providerJobId });
    });

    const result = await http<unknown>(this.key, response_url, { headers, timeoutMs: 30_000, signal: opts.signal });
    const artifacts = this.shapeOutput(input, result.json, providerJobId);
    return { providerKey: this.key, providerJobId, artifacts, meta: { endpoint, waitMs: Date.now() - started } };
  }

  /** Our params → this endpoint's request body. */
  private shapeInput(input: ProviderInput): Record<string, unknown> {
    switch (input.capability) {
      case 'IMAGE_EDIT': {
        const p = this.params(input, 'IMAGE_EDIT');
        return {
          prompt: p.preserveProduct ? `${p.prompt}. Keep the product exactly as it is — same shape, colours, label and proportions. Change only the surroundings.` : p.prompt,
          image_urls: [this.file(input, 'sourceKey')],
          image_size: aspectToFalSize(p.aspect),
          num_images: 1,
          enable_safety_checker: true,
        };
      }
      case 'IMAGE_GENERATE': {
        const p = this.params(input, 'IMAGE_GENERATE');
        return { prompt: p.style ? `${p.prompt}. Style: ${p.style}` : p.prompt, image_size: aspectToFalSize(p.aspect), num_images: p.count, enable_safety_checker: true };
      }
      case 'BACKGROUND_REMOVE':
        return { image_url: this.file(input, 'sourceKey') };
      case 'UPSCALE': {
        const p = this.params(input, 'UPSCALE');
        return { image_url: this.file(input, 'sourceKey'), upscale_factor: p.factor, creativity: 0.2, resemblance: 0.8 };
      }
      case 'IMAGE_TO_VIDEO': {
        const p = this.params(input, 'IMAGE_TO_VIDEO');
        return {
          image_url: this.file(input, 'sourceKey'),
          prompt: p.motion ? `${p.prompt}. Camera: ${p.motion}` : p.prompt,
          duration: String(p.durationSec),
          resolution: this.str(input.config, 'resolution', '720p'),
          aspect_ratio: p.aspect,
          enable_prompt_expansion: true,
        };
      }
      case 'MUSIC': {
        const p = this.params(input, 'MUSIC');
        const desc = [p.styleHints ?? p.genre, p.mood, p.tempo ? `${p.tempo} tempo` : '', p.vocal === 'instrumental' ? 'instrumental' : `${p.vocal} vocals`, p.brief].filter(Boolean).join(', ').slice(0, 300);
        // MiniMax wants lyrics even for instrumentals; an empty structure tag keeps it wordless.
        const lyrics = p.vocal === 'instrumental' ? '[Intro]\n[Instrumental]\n[Outro]' : (p.lyricsText ?? `[Verse]\n${p.brief.slice(0, 400)}`);
        return { prompt: desc.length >= 10 ? desc : `${desc}, upbeat song`, lyrics_prompt: lyrics.slice(0, 3000), audio_setting: { sample_rate: 44100, bitrate: 256000, format: 'mp3' } };
      }
      default:
        return this.unsupported(input.capability);
    }
  }

  /** This endpoint's response → artifacts. Every fal image/video model returns one of a few shapes. */
  private shapeOutput(input: ProviderInput, out: unknown, providerJobId: string): ProviderArtifact[] {
    const images = (pick<Array<{ url: string; width?: number; height?: number; content_type?: string }>>(out, 'images') ?? []);
    const image = pick<{ url: string; width?: number; height?: number; content_type?: string }>(out, 'image');
    const video = pick<{ url: string; content_type?: string }>(out, 'video');
    const audio = pick<{ url: string; content_type?: string }>(out, 'audio');

    const list: ProviderArtifact[] = [];
    if (audio) list.push({ url: audio.url, mime: audio.content_type ?? 'audio/mpeg', role: 'audio' });
    for (const im of images) list.push({ url: im.url, mime: im.content_type ?? 'image/png', role: 'image', width: im.width, height: im.height });
    if (image) list.push({ url: image.url, mime: image.content_type ?? 'image/png', role: 'image', width: image.width, height: image.height });
    if (video) list.push({ url: video.url, mime: video.content_type ?? 'video/mp4', role: 'video' });

    if (list.length === 0) {
      const nsfw = pick<boolean[]>(out, 'has_nsfw_concepts')?.some(Boolean);
      throw new ProviderError(nsfw ? 'CONTENT_REJECTED' : 'RETRYABLE', `${this.key}: no output in response for ${input.capability}`, this.key, { providerJobId, raw: out });
    }
    return list;
  }
}

function aspectToFalSize(aspect: string): string {
  return ({ '1:1': 'square_hd', '4:5': 'portrait_4_3', '3:4': 'portrait_4_3', '9:16': 'portrait_16_9', '16:9': 'landscape_16_9' } as Record<string, string>)[aspect] ?? 'square_hd';
}
