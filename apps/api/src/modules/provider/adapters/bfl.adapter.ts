/**
 * Black Forest Labs — Flux Kontext, the budget tier for "edit this exact image".
 *
 *   POST https://api.bfl.ai/v1/{endpoint}        → { id, polling_url }
 *   GET  {polling_url}                            → { status: Pending | Ready | Error | Content Moderated | Request Moderated, result: { sample } }
 * The sample URL is valid for ten minutes; it is fetched by the pipeline immediately.
 */

import { ProviderError, type Capability, type ProviderInput, type ProviderOpts, type ProviderResult } from '@anystudio/shared';
import { BaseProvider } from './base';
import { fetchBytes, http, pick, poll } from './http';

interface Submit {
  id: string;
  polling_url?: string;
}
interface Status {
  status: string;
  result?: { sample?: string };
  details?: unknown;
}

const KNOWN: Record<string, { capabilities: Capability[]; endpoint: string }> = {
  'bfl:flux-kontext-pro': { capabilities: ['IMAGE_EDIT', 'IMAGE_GENERATE'], endpoint: 'flux-kontext-pro' },
};

export class BflProvider extends BaseProvider {
  static all(apiKey: string): BflProvider[] {
    return Object.entries(KNOWN).map(([key, k]) => new BflProvider(apiKey, key, k.capabilities, k.endpoint));
  }

  constructor(
    private readonly apiKey: string,
    key: string,
    capabilities: Capability[],
    private readonly defaultEndpoint: string,
  ) {
    super(key, capabilities);
  }

  async generate(input: ProviderInput, opts: ProviderOpts): Promise<ProviderResult> {
    const endpoint = this.str(input.config, 'endpoint', this.defaultEndpoint);
    const headers = { 'x-key': this.apiKey };
    let body: Record<string, unknown>;

    if (input.capability === 'IMAGE_EDIT') {
      const p = this.params(input, 'IMAGE_EDIT');
      const { bytes } = await fetchBytes(this.key, this.file(input, 'sourceKey'), Math.min(opts.timeoutMs, 60_000), opts.signal);
      body = {
        prompt: p.preserveProduct ? `${p.prompt}. Keep the product exactly the same; change only the surroundings.` : p.prompt,
        input_image: Buffer.from(bytes).toString('base64'),
        aspect_ratio: p.aspect,
        output_format: 'png',
        safety_tolerance: 2,
      };
    } else if (input.capability === 'IMAGE_GENERATE') {
      const p = this.params(input, 'IMAGE_GENERATE');
      body = { prompt: p.style ? `${p.prompt}. Style: ${p.style}` : p.prompt, aspect_ratio: p.aspect, output_format: 'png', safety_tolerance: 2 };
    } else {
      return this.unsupported(input.capability);
    }

    let providerJobId: string;
    let pollUrl: string;
    if (opts.resume) {
      providerJobId = opts.resume.providerJobId;
      const saved = opts.resume.data?.pollUrl;
      pollUrl = typeof saved === 'string' && saved ? saved : `https://api.bfl.ai/v1/get_result?id=${encodeURIComponent(providerJobId)}`;
    } else {
      const submitted = await http<Submit>(this.key, `https://api.bfl.ai/v1/${endpoint}`, { headers, body, timeoutMs: 30_000, signal: opts.signal });
      providerJobId = submitted.json.id;
      if (!providerJobId) throw new ProviderError('RETRYABLE', `${this.key}: submission returned no id`, this.key, { raw: submitted.json });
      pollUrl = submitted.json.polling_url ?? `https://api.bfl.ai/v1/get_result?id=${encodeURIComponent(providerJobId)}`;
      await opts.onSubmitted?.(providerJobId, { pollUrl });
    }
    opts.onProgress?.('Making your image', 25);

    const final = await poll(
      async () => {
        const s = await http<Status>(this.key, pollUrl, { headers, timeoutMs: 15_000, signal: opts.signal });
        return s.json.status === 'Pending' ? null : s.json;
      },
      { intervalMs: 1_500, timeoutMs: opts.timeoutMs, signal: opts.signal },
    );

    if (final.status !== 'Ready') {
      const moderated = /moderated/i.test(final.status);
      await opts.onSettled?.('FAILED');
      throw new ProviderError(moderated ? 'CONTENT_REJECTED' : 'RETRYABLE', `${this.key}: ${final.status}`, this.key, { providerJobId, raw: final.details });
    }
    const url = pick<string>(final, 'result.sample');
    if (!url) {
      await opts.onSettled?.('FAILED');
      throw new ProviderError('RETRYABLE', `${this.key}: ready but no sample url`, this.key, { providerJobId });
    }
    return { providerKey: this.key, providerJobId, artifacts: [{ url, mime: 'image/png', role: 'image' }], meta: { endpoint } };
  }
}
