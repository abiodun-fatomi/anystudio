/**
 * Replicate — the second aggregator, here for BiRefNet background removal,
 * which is a fraction of a cent per image there.
 *
 *   POST https://api.replicate.com/v1/models/{owner}/{name}/predictions  (Prefer: wait)
 *   GET  https://api.replicate.com/v1/predictions/{id}                    while "processing"
 */

import { ProviderError, type Capability, type ProviderInput, type ProviderOpts, type ProviderResult } from '@anystudio/shared';
import { BaseProvider } from './base';
import { http, pick, poll } from './http';

interface Prediction {
  id: string;
  status: 'starting' | 'processing' | 'succeeded' | 'failed' | 'canceled';
  output?: unknown;
  error?: string;
  urls?: { get: string };
}

const KNOWN: Record<string, { capability: Capability; model: string }> = {
  'replicate:birefnet': { capability: 'BACKGROUND_REMOVE', model: '851-labs/background-remover' },
};

export class ReplicateProvider extends BaseProvider {
  static all(token: string): ReplicateProvider[] {
    return Object.entries(KNOWN).map(([key, k]) => new ReplicateProvider(token, key, k.capability, k.model));
  }

  constructor(
    private readonly token: string,
    key: string,
    capability: Capability,
    private readonly defaultModel: string,
  ) {
    super(key, [capability]);
  }

  async generate(input: ProviderInput, opts: ProviderOpts): Promise<ProviderResult> {
    if (input.capability !== 'BACKGROUND_REMOVE') this.unsupported(input.capability);
    const p = this.params(input, 'BACKGROUND_REMOVE');
    const model = this.str(input.config, 'model', this.defaultModel);
    const headers = { authorization: `Bearer ${this.token}`, prefer: 'wait=30' };
    const body = { input: { image: this.file(input, 'sourceKey'), ...(p.background === 'transparent' ? {} : { background_color: p.background }) } };

    const first = await http<Prediction>(this.key, `https://api.replicate.com/v1/models/${model}/predictions`, {
      headers,
      body,
      timeoutMs: 45_000,
      signal: opts.signal,
    });
    const providerJobId = first.json.id;
    opts.onProgress?.('cutting out the product', 30);

    const final =
      first.json.status === 'succeeded' || first.json.status === 'failed'
        ? first.json
        : await poll(
            async () => {
              const s = await http<Prediction>(this.key, first.json.urls?.get ?? `https://api.replicate.com/v1/predictions/${providerJobId}`, {
                headers: { authorization: headers.authorization },
                timeoutMs: 15_000,
                signal: opts.signal,
              });
              return s.json.status === 'succeeded' || s.json.status === 'failed' || s.json.status === 'canceled' ? s.json : null;
            },
            { intervalMs: 1_000, timeoutMs: opts.timeoutMs, signal: opts.signal },
          );

    if (final.status !== 'succeeded') {
      const msg = final.error ?? final.status;
      throw new ProviderError(/nsfw|safety/i.test(msg) ? 'CONTENT_REJECTED' : 'RETRYABLE', `${this.key}: ${msg}`, this.key, { providerJobId });
    }
    const url = typeof final.output === 'string' ? final.output : pick<string>(final.output, '0');
    if (!url) throw new ProviderError('RETRYABLE', `${this.key}: no output url`, this.key, { providerJobId, raw: final.output });
    return { providerKey: this.key, providerJobId, artifacts: [{ url, mime: 'image/png', role: 'image' }], meta: { model } };
  }
}
