/**
 * Higgsfield — their own DoP image-to-video models through the platform API.
 *
 *   POST https://platform.higgsfield.ai/v1/image2video   (hf-api-key / hf-api-secret headers)
 *   GET  https://platform.higgsfield.ai/v1/requests/{id}  until status is completed
 *
 * The endpoint path, model id and field names are on the ProviderModel row's
 * config so a change on their side is a row edit. This adapter serves the
 * `higgsfield:*` keys; Kling through Higgsfield is a separate row and stays
 * disabled until its resale terms are on file.
 */
import { ProviderError, type Capability, type ProviderInput, type ProviderOpts, type ProviderResult } from '@anystudio/shared';
import { BaseProvider } from './base';
import { http, pick, poll } from './http';

interface Submit { id: string }
interface Status { status: 'queued' | 'in_progress' | 'completed' | 'failed' | 'nsfw'; results?: { raw?: { url?: string }; min?: { url?: string } }; error?: string }

const KNOWN: Record<string, { capability: Capability; model: string }> = {
  'higgsfield:dop-turbo': { capability: 'IMAGE_TO_VIDEO', model: 'dop-turbo' },
  'higgsfield:kling3_0': { capability: 'IMAGE_TO_VIDEO', model: 'kling-3.0' },
};

export class HiggsfieldProvider extends BaseProvider {
  static all(key: string, secret: string): HiggsfieldProvider[] {
    return Object.entries(KNOWN).map(([k, v]) => new HiggsfieldProvider(key, secret, k, v.capability, v.model));
  }

  constructor(private readonly apiKey: string, private readonly apiSecret: string, key: string, capability: Capability, private readonly defaultModel: string) {
    super(key, [capability]);
  }

  async generate(input: ProviderInput, opts: ProviderOpts): Promise<ProviderResult> {
    if (input.capability !== 'IMAGE_TO_VIDEO') this.unsupported(input.capability);
    const p = this.params(input, 'IMAGE_TO_VIDEO');
    const base = this.str(input.config, 'baseUrl', 'https://platform.higgsfield.ai/v1');
    const model = this.str(input.config, 'model', this.defaultModel);
    const headers = { 'hf-api-key': this.apiKey, 'hf-api-secret': this.apiSecret };

    const submitted = await http<Submit>(this.key, `${base}/${this.str(input.config, 'endpoint', 'image2video')}`, {
      headers,
      body: { params: { model, prompt: p.motion ? `${p.prompt}. Camera: ${p.motion}` : p.prompt, input_images: [{ type: 'image_url', image_url: this.file(input, 'sourceKey') }], duration: p.durationSec, aspect_ratio: p.aspect, enhance_prompt: true } },
      timeoutMs: 30_000, signal: opts.signal,
    });
    const providerJobId = submitted.json.id;
    opts.onProgress?.('Higgsfield is rendering', 25);
    const final = await poll(
      async () => {
        const s = await http<Status>(this.key, `${base}/requests/${providerJobId}`, { headers, timeoutMs: 20_000, signal: opts.signal });
        return s.json.status === 'completed' || s.json.status === 'failed' || s.json.status === 'nsfw' ? s.json : null;
      },
      { intervalMs: 6_000, timeoutMs: opts.timeoutMs, signal: opts.signal, onTick: (ms) => opts.onProgress?.(`Higgsfield is rendering (${Math.round(ms / 1000)}s)`, Math.min(80, 25 + ms / 4000)) },
    );
    if (final.status !== 'completed') throw new ProviderError(final.status === 'nsfw' ? 'CONTENT_REJECTED' : 'RETRYABLE', `${this.key}: ${final.error ?? final.status}`, this.key, { providerJobId });
    const url = pick<string>(final, 'results.raw.url') ?? pick<string>(final, 'results.min.url');
    if (!url) throw new ProviderError('RETRYABLE', `${this.key}: completed without a video url`, this.key, { providerJobId });
    return { providerKey: this.key, providerJobId, artifacts: [{ url, mime: 'video/mp4', role: 'video', durationMs: p.durationSec * 1000 }], meta: { model } };
  }
}
