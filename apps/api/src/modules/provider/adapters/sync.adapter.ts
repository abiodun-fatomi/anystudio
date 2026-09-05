/**
 * sync.so — lipsync-2 direct, for when the fal route is down or the
 * account is on contract with sync themselves.
 *
 *   POST https://api.sync.so/v2/generate     { model, input: [{type:'video',url},{type:'audio',url}], options }
 *                                            → { id, status }
 *   GET  https://api.sync.so/v2/generate/{id} → { status: PENDING|PROCESSING|COMPLETED|FAILED|REJECTED|CANCELED, outputUrl, error }
 *
 * REJECTED is sync's moderation: a face they will not animate. That is the
 * customer's input, not a reason to try another vendor.
 *
 * Endpoint shapes from docs.sync.so, September 2026.
 */
import { ProviderError, type Capability, type ProviderInput, type ProviderOpts, type ProviderResult } from '@anystudio/shared';
import { BaseProvider } from './base';
import { http, poll } from './http';

const KNOWN: Record<string, Capability> = { 'sync:lipsync-2': 'LIPSYNC' };

interface SyncJob {
  id?: string;
  status?: string;
  outputUrl?: string | null;
  error?: string | null;
}

export class SyncProvider extends BaseProvider {
  static all(apiKey: string): SyncProvider[] {
    return Object.entries(KNOWN).map(([k, c]) => new SyncProvider(apiKey, k, c));
  }

  constructor(
    private readonly apiKey: string,
    key: string,
    capability: Capability,
  ) {
    super(key, [capability]);
  }

  async generate(input: ProviderInput, opts: ProviderOpts): Promise<ProviderResult> {
    if (input.capability !== 'LIPSYNC') this.unsupported(input.capability);
    const p = this.params(input, 'LIPSYNC');
    const base = this.str(input.config, 'baseUrl', 'https://api.sync.so/v2');
    const model = this.str(input.config, 'model', p.quality === 'precision' ? 'lipsync-2-pro' : 'lipsync-2');
    const headers = { 'x-api-key': this.apiKey };
    const body = {
      model,
      input: [
        { type: 'video', url: this.file(input, 'sourceKey') },
        { type: 'audio', url: this.file(input, 'audioKey') },
      ],
      options: { sync_mode: this.str(input.config, 'syncMode', 'cut_off') },
    };
    const submitted = await http<SyncJob>(this.key, `${base}/generate`, { headers, body, timeoutMs: 30_000, signal: opts.signal });
    const providerJobId = submitted.json.id;
    if (!providerJobId) throw new ProviderError('RETRYABLE', `${this.key}: no id in response`, this.key, { raw: submitted.json });
    opts.onProgress?.('sync is animating the mouth', 15);

    const job = await poll<SyncJob>(
      async () => {
        const s = await http<SyncJob>(this.key, `${base}/generate/${providerJobId}`, { headers, timeoutMs: 20_000, signal: opts.signal });
        const st = (s.json.status ?? '').toUpperCase();
        if (st === 'COMPLETED') return s.json;
        if (st === 'REJECTED')
          throw new ProviderError('CONTENT_REJECTED', `${this.key}: rejected: ${s.json.error ?? 'moderation'}`, this.key, { providerJobId });
        if (st === 'FAILED' || st === 'CANCELED')
          throw new ProviderError('RETRYABLE', `${this.key}: ${st.toLowerCase()}: ${s.json.error ?? 'no reason given'}`, this.key, { providerJobId });
        return null;
      },
      {
        intervalMs: 6_000,
        timeoutMs: opts.timeoutMs,
        signal: opts.signal,
        onTick: (ms) => opts.onProgress?.(`sync is animating the mouth (${Math.round(ms / 1000)}s)`, Math.min(85, 15 + ms / 5000)),
      },
    ).catch((err) => {
      throw err instanceof ProviderError
        ? err
        : new ProviderError('RETRYABLE', `${this.key}: ${err instanceof Error ? err.message : err}`, this.key, { providerJobId });
    });
    if (!job.outputUrl) throw new ProviderError('RETRYABLE', `${this.key}: completed without an outputUrl`, this.key, { providerJobId });
    return { providerKey: this.key, providerJobId, artifacts: [{ url: job.outputUrl, mime: 'video/mp4', role: 'video' }], meta: { model } };
  }
}
