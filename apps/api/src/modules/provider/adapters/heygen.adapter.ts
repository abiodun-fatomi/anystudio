/**
 * HeyGen — video translation with lip resync. The DUB capability, for the
 * dubbing phase; declared now so the row can be enabled the day the terms
 * are on file.
 *
 *   POST https://api.heygen.com/v2/video_translate         { video_url, output_language, translate_audio_only }
 *   GET  https://api.heygen.com/v2/video_translate/{id}    until status is success
 */
import { ProviderError, type Capability, type ProviderInput, type ProviderOpts, type ProviderResult } from '@anystudio/shared';
import { BaseProvider } from './base';
import { http, pick, poll } from './http';

const KNOWN: Record<string, Capability> = { 'heygen:translate': 'DUB' };

export class HeyGenProvider extends BaseProvider {
  static all(apiKey: string): HeyGenProvider[] {
    return Object.entries(KNOWN).map(([k, c]) => new HeyGenProvider(apiKey, k, c));
  }

  constructor(private readonly apiKey: string, key: string, capability: Capability) {
    super(key, [capability]);
  }

  async generate(input: ProviderInput, opts: ProviderOpts): Promise<ProviderResult> {
    if (input.capability !== 'DUB') this.unsupported(input.capability);
    const p = this.params(input, 'DUB');
    const headers = { 'x-api-key': this.apiKey };
    const base = this.str(input.config, 'baseUrl', 'https://api.heygen.com/v2');
    const submitted = await http<{ data?: { video_translate_id?: string }; error?: { message?: string } }>(this.key, `${base}/video_translate`, {
      headers,
      body: { video_url: this.file(input, 'sourceKey'), output_language: p.targetLanguage, translate_audio_only: !p.lipsync },
      timeoutMs: 30_000, signal: opts.signal,
    });
    const providerJobId = submitted.json.data?.video_translate_id;
    if (!providerJobId) throw new ProviderError('RETRYABLE', `${this.key}: ${submitted.json.error?.message ?? 'no job id'}`, this.key);
    opts.onProgress?.('HeyGen is translating', 20);
    const final = await poll(
      async () => {
        const s = await http<{ data?: { status?: string; url?: string; message?: string } }>(this.key, `${base}/video_translate/${providerJobId}`, { headers, timeoutMs: 20_000, signal: opts.signal });
        const st = s.json.data?.status;
        return st === 'success' || st === 'failed' ? s.json : null;
      },
      { intervalMs: 10_000, timeoutMs: opts.timeoutMs, signal: opts.signal, onTick: (ms) => opts.onProgress?.(`HeyGen is translating (${Math.round(ms / 1000)}s)`, Math.min(85, 20 + ms / 8000)) },
    );
    const url = pick<string>(final, 'data.url');
    if (pick<string>(final, 'data.status') !== 'success' || !url) throw new ProviderError('RETRYABLE', `${this.key}: ${pick<string>(final, 'data.message') ?? 'translation failed'}`, this.key, { providerJobId });
    return { providerKey: this.key, providerJobId, artifacts: [{ url, mime: 'video/mp4', role: 'video' }], meta: { language: p.targetLanguage, lipsync: p.lipsync } };
  }
}
