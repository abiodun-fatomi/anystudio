/**
 * OpenAI — Sora 2 for image-to-video.
 *
 *   POST https://api.openai.com/v1/videos              (multipart: model, prompt, input_reference, seconds, size)
 *   GET  https://api.openai.com/v1/videos/{id}         until status is completed
 *   GET  https://api.openai.com/v1/videos/{id}/content the MP4
 *
 * Sora's clip lengths are fixed steps (4, 8, 12 s); a 5-second request is
 * rounded to the nearest one the pipeline then trims in the stitch step.
 */

import { ProviderError, type Capability, type ProviderInput, type ProviderOpts, type ProviderResult } from '@anystudio/shared';
import { BaseProvider } from './base';
import { fetchBytes, http, kindForStatus, poll } from './http';

interface Video { id: string; status: 'queued' | 'in_progress' | 'completed' | 'failed'; progress?: number; error?: { message: string; code?: string } }

const KNOWN: Record<string, { capability: Capability; model: string }> = {
  'openai:sora-2': { capability: 'IMAGE_TO_VIDEO', model: 'sora-2' },
};

export class OpenAiProvider extends BaseProvider {
  static all(apiKey: string): OpenAiProvider[] {
    return Object.entries(KNOWN).map(([key, k]) => new OpenAiProvider(apiKey, key, k.capability, k.model));
  }

  constructor(private readonly apiKey: string, key: string, capability: Capability, private readonly defaultModel: string) {
    super(key, [capability]);
  }

  async generate(input: ProviderInput, opts: ProviderOpts): Promise<ProviderResult> {
    if (input.capability !== 'IMAGE_TO_VIDEO') this.unsupported(input.capability);
    const p = this.params(input, 'IMAGE_TO_VIDEO');
    const model = this.str(input.config, 'model', this.defaultModel);
    const auth = { authorization: `Bearer ${this.apiKey}` };

    const source = await fetchBytes(this.key, this.file(input, 'sourceKey'), 60_000);
    const form = new FormData();
    form.set('model', model);
    form.set('prompt', p.motion ? `${p.prompt}. Camera: ${p.motion}` : p.prompt);
    form.set('seconds', String(p.durationSec <= 5 ? 4 : 8));
    form.set('size', this.str(input.config, 'size', p.aspect === '16:9' ? '1280x720' : '720x1280'));
    form.set('input_reference', new Blob([source.bytes], { type: source.mime }), 'reference.png');

    const created = await fetch('https://api.openai.com/v1/videos', { method: 'POST', headers: auth, body: form, signal: AbortSignal.timeout(60_000) }).catch((err: Error) => {
      throw new ProviderError('RETRYABLE', `${this.key}: ${err.message}`, this.key);
    });
    const createdText = await created.text();
    if (!created.ok) {
      const kind = created.status === 400 && /moderation|policy|safety/i.test(createdText) ? 'CONTENT_REJECTED' : kindForStatus(created.status);
      throw new ProviderError(kind, `${this.key}: HTTP ${created.status}: ${createdText.slice(0, 400)}`, this.key, { status: created.status });
    }
    const video = JSON.parse(createdText) as Video;
    const providerJobId = video.id;
    opts.onProgress?.('Sora is rendering', 20);

    const final = await poll(
      async () => {
        const s = await http<Video>(this.key, `https://api.openai.com/v1/videos/${providerJobId}`, { headers: auth, timeoutMs: 20_000, signal: opts.signal });
        if (s.json.status === 'completed' || s.json.status === 'failed') return s.json;
        if (s.json.progress !== undefined) opts.onProgress?.(`Sora is rendering (${s.json.progress}%)`, 20 + s.json.progress * 0.6);
        return null;
      },
      { intervalMs: 8_000, timeoutMs: opts.timeoutMs, signal: opts.signal },
    );
    if (final.status !== 'completed') {
      const msg = final.error?.message ?? 'failed';
      throw new ProviderError(/moderation|policy|safety/i.test(msg) ? 'CONTENT_REJECTED' : 'RETRYABLE', `${this.key}: ${msg}`, this.key, { providerJobId });
    }

    const res = await fetch(`https://api.openai.com/v1/videos/${providerJobId}/content`, { headers: auth, signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new ProviderError(kindForStatus(res.status), `${this.key}: could not download video (${res.status})`, this.key, { providerJobId });
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { providerKey: this.key, providerJobId, artifacts: [{ bytes, mime: 'video/mp4', role: 'video' }], meta: { model } };
  }
}
