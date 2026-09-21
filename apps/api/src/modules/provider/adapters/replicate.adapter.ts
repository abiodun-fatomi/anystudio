/**
 * Replicate — the second aggregator, here for BiRefNet background removal,
 * which is a fraction of a cent per image there.
 *
 *   POST https://api.replicate.com/v1/models/{owner}/{name}/predictions  (Prefer: wait)
 *   GET  https://api.replicate.com/v1/predictions/{id}                    while "processing"
 */

import { ProviderError, type Capability, type ProviderInput, type ProviderOpts, type ProviderResult } from '@anystudio/shared';
import { BaseProvider } from './base';
import sharp from 'sharp';
import { fetchBytes, http, pick, poll } from './http';

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
    const version = this.str(input.config, 'version', '');
    const headers = { authorization: `Bearer ${this.token}`, prefer: 'wait=30' };
    const body = { input: { image: this.file(input, 'sourceKey') } };

    let providerJobId: string;
    let pollUrl: string;
    let first: Prediction | undefined;
    if (opts.resume) {
      providerJobId = opts.resume.providerJobId;
      const saved = opts.resume.data?.pollUrl;
      pollUrl = typeof saved === 'string' && saved ? saved : `https://api.replicate.com/v1/predictions/${encodeURIComponent(providerJobId)}`;
    } else {
      // Replicate's path-style endpoint serves only its official models; a
      // community model 404s there and must be pinned by version through
      // /v1/predictions. The version id lives on the routing row, so a model
      // update stays a config edit, not a deploy.
      const endpoint = version ? 'https://api.replicate.com/v1/predictions' : `https://api.replicate.com/v1/models/${model}/predictions`;
      const response = await http<Prediction>(this.key, endpoint, {
        headers,
        body: version ? { version, ...body } : body,
        timeoutMs: 45_000,
        signal: opts.signal,
      });
      first = response.json;
      providerJobId = first.id;
      if (!providerJobId) throw new ProviderError('RETRYABLE', `${this.key}: submission returned no prediction id`, this.key, { raw: first });
      pollUrl = first.urls?.get ?? `https://api.replicate.com/v1/predictions/${encodeURIComponent(providerJobId)}`;
      await opts.onSubmitted?.(providerJobId, { pollUrl });
    }
    opts.onProgress?.('Cutting out your product', 30);

    const final =
      first && (first.status === 'succeeded' || first.status === 'failed')
        ? first
        : await poll(
            async () => {
              const s = await http<Prediction>(this.key, pollUrl, {
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
      await opts.onSettled?.('FAILED');
      throw new ProviderError(/nsfw|safety/i.test(msg) ? 'CONTENT_REJECTED' : 'RETRYABLE', `${this.key}: ${msg}`, this.key, { providerJobId });
    }
    const url = typeof final.output === 'string' ? final.output : pick<string>(final.output, '0');
    if (!url) {
      await opts.onSettled?.('FAILED');
      throw new ProviderError('RETRYABLE', `${this.key}: no output url`, this.key, { providerJobId, raw: final.output });
    }
    // The model knows nothing about backgrounds: it returns a transparent
    // cutout, always. A requested colour is composited here with sharp, so the
    // customer gets the exact hex they picked instead of a vendor's guess.
    if (p.background !== 'transparent') {
      const cutout = await fetchBytes(this.key, url, 30_000, opts.signal);
      const bytes = await sharp(Buffer.from(cutout.bytes)).flatten({ background: p.background }).png().toBuffer();
      return { providerKey: this.key, providerJobId, artifacts: [{ bytes, mime: 'image/png', role: 'image' }], meta: { model, background: p.background } };
    }
    return { providerKey: this.key, providerJobId, artifacts: [{ url, mime: 'image/png', role: 'image' }], meta: { model } };
  }
}
