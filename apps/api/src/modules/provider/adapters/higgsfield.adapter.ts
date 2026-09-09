/**
 * Higgsfield — their own DoP image-to-video models through the platform API.
 *
 *   POST https://api.higgsfield.ai/higgsfield-ai/dop/turbo
 *   GET  https://api.higgsfield.ai/requests/{request_id}/status
 *   Authorization: Key KEY_ID:KEY_SECRET
 *
 * Model selection is configured on the ProviderModel row; payloads and paths
 * must match a verified schema. Kling stays disabled until its schema and
 * resale terms are verified. The shared request lifecycle can still resume
 * previously recorded jobs without submitting a new generation.
 */
import { ProviderError, type Capability, type ProviderInput, type ProviderOpts, type ProviderResult } from '@anystudio/shared';
import { BaseProvider } from './base';
import { http, pick, poll } from './http';

interface Status {
  request_id: string;
  status: 'queued' | 'in_progress' | 'completed' | 'failed' | 'nsfw' | 'canceled';
  video?: { url?: string };
  error?: string;
}

// Verified against https://docs.higgsfield.ai/docs/openapi.json (2026-09-09).
// Do not guess a third-party model's endpoint or reuse DoP's payload for it.
const DOP_ENDPOINTS: Record<string, string> = {
  'dop-turbo': 'higgsfield-ai/dop/turbo',
  'dop-lite': 'higgsfield-ai/dop/lite',
  'dop-standard': 'higgsfield-ai/dop/standard',
};

const KNOWN: Record<string, { capability: Capability; model: string }> = {
  'higgsfield:dop-turbo': { capability: 'IMAGE_TO_VIDEO', model: 'dop-turbo' },
  'higgsfield:kling3_0': { capability: 'IMAGE_TO_VIDEO', model: 'kling-3.0' },
};

export class HiggsfieldProvider extends BaseProvider {
  static all(key: string, secret: string): HiggsfieldProvider[] {
    return Object.entries(KNOWN).map(([k, v]) => new HiggsfieldProvider(key, secret, k, v.capability, v.model));
  }

  constructor(
    private readonly apiKey: string,
    private readonly apiSecret: string,
    key: string,
    capability: Capability,
    private readonly defaultModel: string,
  ) {
    super(key, [capability]);
  }

  async generate(input: ProviderInput, opts: ProviderOpts): Promise<ProviderResult> {
    if (input.capability !== 'IMAGE_TO_VIDEO') this.unsupported(input.capability);
    const p = this.params(input, 'IMAGE_TO_VIDEO');
    // Existing model rows may still contain the old /v1 base URL.
    const configuredBase = this.str(input.config, 'baseUrl', 'https://api.higgsfield.ai').replace(/\/+$/, '');
    const base = /^https:\/\/(platform|api)\.higgsfield\.ai(?:\/v1)?$/.test(configuredBase) ? 'https://api.higgsfield.ai' : configuredBase;
    const model = this.str(input.config, 'model', this.defaultModel);
    const headers = { Authorization: `Key ${this.apiKey}:${this.apiSecret}` };

    let providerJobId: string;
    if (opts.resume) {
      providerJobId = opts.resume.providerJobId;
    } else {
      const endpoint = DOP_ENDPOINTS[model];
      if (!endpoint) throw new ProviderError('PROVIDER_DOWN', `${this.key}: no verified request schema for model ${model}`, this.key);
      const configuredEndpoint = this.str(input.config, 'endpoint', endpoint).replace(/^\/+/, '');
      if (![endpoint, 'image2video', 'image2video/dop', 'v1/image2video/dop'].includes(configuredEndpoint)) {
        throw new ProviderError('PROVIDER_DOWN', `${this.key}: unsupported endpoint configuration`, this.key);
      }
      const submitted = await http<Status>(this.key, `${base}/${endpoint}`, {
        headers,
        body: {
          prompt: p.motion ? `${p.prompt}. Camera: ${p.motion}` : p.prompt,
          image_url: this.file(input, 'sourceKey'),
          enhance_prompt: true,
        },
        timeoutMs: 30_000,
        signal: opts.signal,
      });
      providerJobId = submitted.json?.request_id;
      if (typeof providerJobId !== 'string' || !providerJobId.trim()) {
        // A successful HTTP response may already represent a charged render.
        // Never allow a missing id to trigger another paid submission.
        throw new ProviderError('SUBMISSION_UNKNOWN', `${this.key}: submission returned no request id`, this.key);
      }
      await opts.onSubmitted?.(providerJobId);
    }
    opts.onProgress?.('Rendering your video', 25);
    const final = await poll(
      async () => {
        // Construct the URL ourselves; never send credentials to a response-supplied status_url.
        const s = await http<Status>(this.key, `${base}/requests/${encodeURIComponent(providerJobId)}/status`, {
          headers,
          timeoutMs: 20_000,
          signal: opts.signal,
        });
        return ['completed', 'failed', 'nsfw', 'canceled'].includes(s.json.status) ? s.json : null;
      },
      {
        intervalMs: 6_000,
        timeoutMs: opts.timeoutMs,
        signal: opts.signal,
        onTick: (ms) => opts.onProgress?.(`Rendering your video (${Math.round(ms / 1000)}s)`, Math.min(80, 25 + ms / 4000)),
      },
    );
    if (final.status !== 'completed') {
      await opts.onSettled?.('FAILED');
      throw new ProviderError(final.status === 'nsfw' ? 'CONTENT_REJECTED' : 'RETRYABLE', `${this.key}: ${final.error ?? final.status}`, this.key, {
        providerJobId,
      });
    }
    const url = pick<string>(final, 'video.url');
    if (!url) {
      await opts.onSettled?.('FAILED');
      throw new ProviderError('RETRYABLE', `${this.key}: completed without a video url`, this.key, { providerJobId });
    }
    // DoP's schema has no duration/aspect controls. Let media inspection record
    // the actual duration rather than claiming it matched the requested length.
    return { providerKey: this.key, providerJobId, artifacts: [{ url, mime: 'video/mp4', role: 'video' }], meta: { model } };
  }
}
