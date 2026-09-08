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

interface FalSubmit {
  request_id: string;
  status_url: string;
  response_url: string;
}
interface FalStatus {
  status: 'IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED';
  queue_position?: number;
  logs?: Array<{ message: string }>;
}

const QUEUE = 'https://queue.fal.run';

/** The endpoints we know how to shape input for, with their default paths. */
const KNOWN: Record<string, { capability: Capability; endpoint: string }> = {
  'fal:seedream-4.5-edit': { capability: 'IMAGE_EDIT', endpoint: 'fal-ai/bytedance/seedream/v4.5/edit' },
  'fal:flux-2-pro': { capability: 'IMAGE_GENERATE', endpoint: 'fal-ai/flux-2-pro' },
  'fal:bria-rmbg-2': { capability: 'BACKGROUND_REMOVE', endpoint: 'fal-ai/bria/background/remove' },
  'fal:clarity-upscaler': { capability: 'UPSCALE', endpoint: 'fal-ai/clarity-upscaler' },
  'fal:wan-2.5-i2v': { capability: 'IMAGE_TO_VIDEO', endpoint: 'fal-ai/wan-25-preview/image-to-video' },
  'fal:minimax-music-v2': { capability: 'MUSIC', endpoint: 'fal-ai/minimax-music/v2' },
  'fal:sync-lipsync': { capability: 'LIPSYNC', endpoint: 'fal-ai/sync-lipsync/v2' },
};

/**
 * The clip lengths an endpoint will actually accept, in seconds.
 *
 * Our plans are built on 5 and 8 (AD_PLANS), and most vendors take both.
 * wan-2.5 does not — it takes 5 or 10, and answers an 8 with a 422 before it
 * renders anything. That cost us three of every four shots in an ad: each one
 * failed here and fell through to vertex:veo-3.1-fast at 260 minor against
 * fal's 80, so the bug was billed as well as logged.
 *
 * A row's `config.durations` overrides this, so a vendor changing their grid
 * is an UPDATE and not a deploy.
 */
const DURATIONS: Record<string, readonly number[]> = {
  'fal-ai/wan-25-preview/image-to-video': [5, 10],
};

/** Wan 2.5's published input limit. Keep this next to its duration contract. */
const WAN_ENDPOINT = 'fal-ai/wan-25-preview/image-to-video';
export const WAN_PROMPT_MAX = 1500;

/** Compose the camera direction without ever sending Wan an over-limit prompt. */
export function wanPrompt(prompt: string, motion?: string): string {
  const camera = motion?.trim() ? `. Camera: ${motion.trim()}` : '';
  return `${prompt}${camera}`.slice(0, WAN_PROMPT_MAX);
}

/**
 * The clip length to ask this endpoint for, given the one the plan wants.
 *
 * Standalone reels choose the nearest allowed length that does not run long.
 * A child of a multi-shot ad instead covers the requested slot: the isolated
 * stitch worker trims a 10-second Wan clip to the planned 8 seconds. That
 * preserves motion throughout the paid 30/45/60-second ad; rounding every
 * eight-second child down to five silently turned a 30-second ad into 20.
 */
export function snapDuration(wanted: number, allowed: readonly number[] | undefined, cover = false): number {
  if (!allowed?.length || allowed.includes(wanted)) return wanted;
  if (cover) {
    const over = allowed.filter((d) => d > wanted);
    if (over.length) return Math.min(...over);
  }
  const under = allowed.filter((d) => d < wanted);
  return under.length ? Math.max(...under) : Math.min(...allowed);
}

/** A request for the precision model must outrank a row-level speed default. */
export function lipsyncModel(quality: 'speed' | 'precision', configured?: string): string {
  return quality === 'precision' ? 'lipsync-2-pro' : (configured ?? 'lipsync-2');
}

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
    let providerJobId: string;
    let statusUrl: string;
    let responseUrl: string;
    if (opts.resume) {
      providerJobId = opts.resume.providerJobId;
      statusUrl = resumeString(this.key, opts, 'statusUrl');
      responseUrl = resumeString(this.key, opts, 'responseUrl');
    } else {
      const body = this.shapeInput(input);
      const submitted = await http<FalSubmit>(this.key, `${QUEUE}/${endpoint}`, { body, headers, timeoutMs: 30_000, signal: opts.signal });
      providerJobId = submitted.json.request_id;
      statusUrl = submitted.json.status_url;
      responseUrl = submitted.json.response_url;
      if (!providerJobId || !statusUrl || !responseUrl)
        throw new ProviderError('RETRYABLE', `${this.key}: queue response did not contain resumable job coordinates`, this.key, { raw: submitted.json });
      await opts.onSubmitted?.(providerJobId, { statusUrl, responseUrl });
    }
    opts.onProgress?.('Waiting for a rendering slot', 10);

    const started = Date.now();
    await poll(
      async () => {
        const s = await http<FalStatus>(this.key, `${statusUrl}?logs=0`, { headers, timeoutMs: 15_000, signal: opts.signal });
        if (s.json.status === 'COMPLETED') return true;
        if (s.json.status === 'IN_PROGRESS') opts.onProgress?.('Rendering', 40);
        else if (s.json.queue_position !== undefined) opts.onProgress?.(`waiting in queue (position ${s.json.queue_position})`, 15);
        return null;
      },
      { intervalMs: input.capability === 'IMAGE_TO_VIDEO' || input.capability === 'LIPSYNC' ? 5_000 : 1_500, timeoutMs: opts.timeoutMs, signal: opts.signal },
    ).catch((err) => {
      throw err instanceof ProviderError
        ? err
        : new ProviderError('RETRYABLE', `${this.key}: ${err instanceof Error ? err.message : err}`, this.key, { providerJobId });
    });

    const result = await http<unknown>(this.key, responseUrl, { headers, timeoutMs: 30_000, signal: opts.signal }).catch(async (err: unknown) => {
      // Only a completed job's structured validation response proves terminal
      // rejection. Auth errors, missing jobs, transport failures and generic
      // 422s must retain the journal's ambiguous-submission protection.
      if (err instanceof ProviderError && err.meta.status === 422) {
        const detail = (err.meta.raw as { detail?: unknown } | null)?.detail;
        if (
          Array.isArray(detail) &&
          detail.length > 0 &&
          detail.every((item) => item && item.type === 'value_error' && Array.isArray(item.loc) && item.loc[0] === 'body' && typeof item.msg === 'string')
        ) {
          await opts.onSettled?.('FAILED');
          throw new ProviderError('REQUEST_REJECTED', `${this.key}: ${detail.map((item) => item.msg).join('; ')}`, this.key, { ...err.meta, providerJobId });
        }
      }
      throw err;
    });
    let artifacts: ProviderArtifact[];
    try {
      artifacts = this.shapeOutput(input, result.json, providerJobId);
    } catch (err) {
      await opts.onSettled?.('FAILED');
      throw err;
    }
    let costMinor: number | undefined;
    const perSecond = Number(input.config.costPerSecondMinor);
    if (input.capability === 'IMAGE_TO_VIDEO' && Number.isFinite(perSecond) && perSecond > 0) {
      const p = this.params(input, 'IMAGE_TO_VIDEO');
      const seconds = snapDuration(p.durationSec, this.nums(input.config, 'durations', DURATIONS[endpoint]), p.shotIndex !== undefined);
      costMinor = Math.ceil(seconds * perSecond);
    } else if (input.capability === 'IMAGE_GENERATE') {
      const unit = Number(input.config.costMinor);
      if (Number.isFinite(unit) && unit >= 0) costMinor = Math.ceil(this.params(input, 'IMAGE_GENERATE').count * unit);
    }
    return { providerKey: this.key, providerJobId, artifacts, costMinor, meta: { endpoint, waitMs: Date.now() - started } };
  }

  /** Our params → this endpoint's request body. */
  private shapeInput(input: ProviderInput): Record<string, unknown> {
    switch (input.capability) {
      case 'IMAGE_EDIT': {
        const p = this.params(input, 'IMAGE_EDIT');
        return {
          prompt: p.preserveProduct
            ? `${p.prompt}. Keep the product exactly as it is — same shape, colours, label and proportions. Change only the surroundings.`
            : p.prompt,
          image_urls: [this.file(input, 'sourceKey')],
          image_size: aspectToFalSize(p.aspect),
          num_images: 1,
          enable_safety_checker: true,
        };
      }
      case 'IMAGE_GENERATE': {
        const p = this.params(input, 'IMAGE_GENERATE');
        return {
          prompt: p.style ? `${p.prompt}. Style: ${p.style}` : p.prompt,
          image_size: aspectToFalSize(p.aspect),
          num_images: p.count,
          enable_safety_checker: true,
        };
      }
      case 'BACKGROUND_REMOVE':
        return { image_url: this.file(input, 'sourceKey') };
      case 'UPSCALE': {
        const p = this.params(input, 'UPSCALE');
        return { image_url: this.file(input, 'sourceKey'), upscale_factor: p.factor, creativity: 0.2, resemblance: 0.8 };
      }
      case 'IMAGE_TO_VIDEO': {
        const p = this.params(input, 'IMAGE_TO_VIDEO');
        const endpoint = this.str(input.config, 'endpoint', this.defaultEndpoint);
        return {
          image_url: this.file(input, 'sourceKey'),
          prompt: endpoint === WAN_ENDPOINT ? wanPrompt(p.prompt, p.motion) : p.motion ? `${p.prompt}. Camera: ${p.motion}` : p.prompt,
          duration: String(snapDuration(p.durationSec, this.nums(input.config, 'durations', DURATIONS[endpoint]), p.shotIndex !== undefined)),
          resolution: this.str(input.config, 'resolution', '720p'),
          // Wan image-to-video has no aspect_ratio field: its frame follows
          // the input image. Sending an invented field risks a 422 as fal's
          // schema tightens; exact product framing is handled after rendering.
          ...(endpoint === WAN_ENDPOINT ? {} : { aspect_ratio: p.aspect }),
          enable_prompt_expansion: true,
        };
      }
      case 'MUSIC': {
        const p = this.params(input, 'MUSIC');
        const desc = [
          p.styleHints ?? p.genre,
          p.mood,
          p.tempo ? `${p.tempo} tempo` : '',
          p.vocal === 'instrumental' ? 'instrumental' : `${p.vocal} vocals`,
          p.brief,
        ]
          .filter(Boolean)
          .join(', ')
          .slice(0, 300);
        // MiniMax wants lyrics even for instrumentals; an empty structure tag keeps it wordless.
        const lyrics = p.vocal === 'instrumental' ? '[Intro]\n[Instrumental]\n[Outro]' : (p.lyricsText ?? `[Verse]\n${p.brief.slice(0, 400)}`);
        return {
          prompt: desc.length >= 10 ? desc : `${desc}, upbeat song`,
          lyrics_prompt: lyrics.slice(0, 3000),
          audio_setting: { sample_rate: 44100, bitrate: 256000, format: 'mp3' },
        };
      }
      case 'LIPSYNC': {
        const p = this.params(input, 'LIPSYNC');
        // sync.so's lipsync-2 through fal. `cut_off` ends the video when the audio does — a Status clip should not loop its last word.
        return {
          video_url: this.file(input, 'sourceKey'),
          audio_url: this.file(input, 'audioKey'),
          // A customer's precision choice is stronger than a row-level default.
          // This also keeps an old seeded `lipsync-2` value from silently
          // downgrading a precision request.
          model: lipsyncModel(p.quality, this.str(input.config, 'model', 'lipsync-2')),
          sync_mode: this.str(input.config, 'syncMode', 'cut_off'),
        };
      }
      default:
        return this.unsupported(input.capability);
    }
  }

  /** This endpoint's response → artifacts. Every fal image/video model returns one of a few shapes. */
  private shapeOutput(input: ProviderInput, out: unknown, providerJobId: string): ProviderArtifact[] {
    const images = pick<Array<{ url: string; width?: number; height?: number; content_type?: string }>>(out, 'images') ?? [];
    const image = pick<{ url: string; width?: number; height?: number; content_type?: string }>(out, 'image');
    const video = pick<{ url: string; content_type?: string }>(out, 'video');
    const audio = pick<{ url: string; content_type?: string }>(out, 'audio');

    const list: ProviderArtifact[] = [];
    if (audio) list.push({ url: audio.url, mime: audio.content_type ?? 'audio/mpeg', role: 'audio' });
    for (const im of images) list.push({ url: im.url, mime: im.content_type ?? 'image/png', role: 'image', width: im.width, height: im.height });
    if (image) list.push({ url: image.url, mime: image.content_type ?? 'image/png', role: 'image', width: image.width, height: image.height });
    // The length we ASKED for, not the length in the plan: when snapDuration
    // rounded an 8 down to a 5, the shot really is five seconds and whatever
    // times captions against it needs to know that.
    if (video) {
      const asked =
        input.capability === 'IMAGE_TO_VIDEO'
          ? snapDuration(
              this.params(input, 'IMAGE_TO_VIDEO').durationSec,
              this.nums(input.config, 'durations', DURATIONS[this.str(input.config, 'endpoint', this.defaultEndpoint)]),
              this.params(input, 'IMAGE_TO_VIDEO').shotIndex !== undefined,
            )
          : undefined;
      list.push({ url: video.url, mime: video.content_type ?? 'video/mp4', role: 'video', ...(asked ? { durationMs: asked * 1000 } : {}) });
    }

    if (list.length === 0) {
      const nsfw = pick<boolean[]>(out, 'has_nsfw_concepts')?.some(Boolean);
      throw new ProviderError(nsfw ? 'CONTENT_REJECTED' : 'RETRYABLE', `${this.key}: no output in response for ${input.capability}`, this.key, {
        providerJobId,
        raw: out,
      });
    }
    return list;
  }
}

function resumeString(providerKey: string, opts: ProviderOpts, key: string): string {
  const value = opts.resume?.data?.[key];
  if (typeof value !== 'string' || !value)
    throw new ProviderError(
      'SUBMISSION_UNKNOWN',
      `${providerKey}: saved job ${opts.resume?.providerJobId ?? '(unknown)'} has no ${key}; refusing to resubmit`,
      providerKey,
    );
  return value;
}

function aspectToFalSize(aspect: string): string {
  return (
    ({ '1:1': 'square_hd', '4:5': 'portrait_4_3', '3:4': 'portrait_4_3', '9:16': 'portrait_16_9', '16:9': 'landscape_16_9' } as Record<string, string>)[
      aspect
    ] ?? 'square_hd'
  );
}
