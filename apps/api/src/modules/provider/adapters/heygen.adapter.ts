/**
 * HeyGen — video translation with the speaker's own voice and re-animated
 * lips (DUB), and lip-sync of new audio onto an existing video (LIPSYNC).
 *
 *   POST https://api.heygen.com/v3/video-translations   { video: {type:'url',url}, output_languages: [name], mode, translate_audio_only, speaker_num, input_language }
 *                                                       → { data: { video_translation_ids: [id] } }
 *   GET  https://api.heygen.com/v3/video-translations/{id}   → { data?: { status: pending|running|completed|failed, video_url, failure_message } }
 *   POST https://api.heygen.com/v3/lipsyncs              { video, audio, mode }  → { data: { lipsync_id } }
 *   GET  https://api.heygen.com/v3/lipsyncs/{id}         → same status shape, video_url when completed
 *
 * HeyGen names languages ("English (Nigeria)", "Swahili (Kenya)") rather
 * than coding them; DUB_LANGUAGES carries the name for every code we
 * offer. `mode: 'precision'` costs more and takes longer; the row's config
 * may pin it, otherwise the request's `quality` decides.
 *
 * Endpoint shapes from HeyGen's v3 reference, September 2026. Some
 * responses wrap the object in `data` and some do not; both are read.
 */
import { ProviderError, dubLanguage, type Capability, type ProviderInput, type ProviderOpts, type ProviderResult } from '@anystudio/shared';
import { BaseProvider } from './base';
import { http, pick, poll } from './http';

const KNOWN: Record<string, Capability> = { 'heygen:translate': 'DUB', 'heygen:lipsync': 'LIPSYNC' };

interface HeyGenJob { status?: string; video_url?: string; failure_message?: string; output_language?: string }

export class HeyGenProvider extends BaseProvider {
  static all(apiKey: string): HeyGenProvider[] {
    return Object.entries(KNOWN).map(([k, c]) => new HeyGenProvider(apiKey, k, c));
  }

  constructor(private readonly apiKey: string, key: string, capability: Capability) {
    super(key, [capability]);
  }

  async generate(input: ProviderInput, opts: ProviderOpts): Promise<ProviderResult> {
    switch (input.capability) {
      case 'DUB': return this.translate(input, opts);
      case 'LIPSYNC': return this.lipsync(input, opts);
      default: return this.unsupported(input.capability);
    }
  }

  private async translate(input: ProviderInput, opts: ProviderOpts): Promise<ProviderResult> {
    const p = this.params(input, 'DUB');
    const name = dubLanguage(p.targetLanguage)?.heygen;
    if (!name) throw new ProviderError('INVALID_INPUT', `${this.key}: cannot translate into "${p.targetLanguage}"`, this.key);
    const base = this.str(input.config, 'baseUrl', 'https://api.heygen.com/v3');
    const mode = this.str(input.config, 'mode', p.quality);
    const body: Record<string, unknown> = {
      video: { type: 'url', url: this.file(input, 'sourceKey') },
      output_languages: [name],
      mode,
      translate_audio_only: !p.lipsync,
      disable_music_track: !p.keepBackground,
      enable_dynamic_duration: true,
      title: `anystudio ${input.generationId}`,
    };
    if (p.speakers > 0) body.speaker_num = p.speakers;
    if (p.sourceLanguage && p.sourceLanguage !== 'auto') body.input_language = p.sourceLanguage;

    const submitted = await http<unknown>(this.key, `${base}/video-translations`, { headers: this.headers(), body, timeoutMs: 30_000, signal: opts.signal });
    const providerJobId = pick<string[]>(submitted.json, 'data.video_translation_ids')?.[0] ?? pick<string[]>(submitted.json, 'video_translation_ids')?.[0];
    if (!providerJobId) throw new ProviderError('RETRYABLE', `${this.key}: ${pick<string>(submitted.json, 'error.message') ?? 'no job id in response'}`, this.key, { raw: submitted.json });
    opts.onProgress?.('HeyGen is translating', 15);

    const job = await this.wait(`${base}/video-translations/${providerJobId}`, providerJobId, opts, 'translating');
    return {
      providerKey: this.key, providerJobId,
      artifacts: [{ url: job.video_url!, mime: 'video/mp4', role: 'video' }],
      meta: { language: p.targetLanguage, heygenLanguage: name, lipsync: p.lipsync, mode },
    };
  }

  private async lipsync(input: ProviderInput, opts: ProviderOpts): Promise<ProviderResult> {
    const p = this.params(input, 'LIPSYNC');
    const base = this.str(input.config, 'baseUrl', 'https://api.heygen.com/v3');
    const mode = this.str(input.config, 'mode', p.quality);
    const body = {
      video: { type: 'url', url: this.file(input, 'sourceKey') },
      audio: { type: 'url', url: this.file(input, 'audioKey') },
      mode,
      enable_dynamic_duration: true,
      title: `anystudio ${input.generationId}`,
    };
    const submitted = await http<unknown>(this.key, `${base}/lipsyncs`, { headers: this.headers(), body, timeoutMs: 30_000, signal: opts.signal });
    const providerJobId = pick<string>(submitted.json, 'data.lipsync_id') ?? pick<string>(submitted.json, 'lipsync_id');
    if (!providerJobId) throw new ProviderError('RETRYABLE', `${this.key}: ${pick<string>(submitted.json, 'error.message') ?? 'no job id in response'}`, this.key, { raw: submitted.json });
    opts.onProgress?.('HeyGen is syncing the lips', 15);

    const job = await this.wait(`${base}/lipsyncs/${providerJobId}`, providerJobId, opts, 'syncing');
    return { providerKey: this.key, providerJobId, artifacts: [{ url: job.video_url!, mime: 'video/mp4', role: 'video' }], meta: { mode } };
  }

  private headers(): Record<string, string> { return { 'x-api-key': this.apiKey }; }

  /** Poll until the job settles; a failure message decides whether it was our input or their day. */
  private async wait(url: string, providerJobId: string, opts: ProviderOpts, verb: string): Promise<HeyGenJob> {
    return poll<HeyGenJob>(
      async () => {
        const s = await http<unknown>(this.key, url, { headers: this.headers(), timeoutMs: 20_000, signal: opts.signal });
        const job = (pick<HeyGenJob>(s.json, 'data') ?? (s.json as HeyGenJob)) ?? {};
        const st = (job.status ?? '').toLowerCase();
        if (st === 'completed' || st === 'success') {
          if (!job.video_url) throw new ProviderError('RETRYABLE', `${this.key}: completed without a video_url`, this.key, { providerJobId });
          return job;
        }
        if (st === 'failed' || st === 'error') throw new ProviderError(classifyFailure(job.failure_message), `${this.key}: ${job.failure_message ?? 'job failed'}`, this.key, { providerJobId });
        return null;
      },
      { intervalMs: 10_000, timeoutMs: opts.timeoutMs, signal: opts.signal, onTick: (ms) => opts.onProgress?.(`HeyGen is ${verb} (${Math.round(ms / 1000)}s)`, Math.min(85, 15 + ms / 6000)) },
    ).catch((err) => { throw err instanceof ProviderError ? err : new ProviderError('RETRYABLE', `${this.key}: ${err instanceof Error ? err.message : err}`, this.key, { providerJobId }); });
  }
}

export function classifyFailure(message: string | undefined): 'CONTENT_REJECTED' | 'INVALID_INPUT' | 'RETRYABLE' {
  const m = (message ?? '').toLowerCase();
  if (/moderation|policy|violat|inappropriate|consent/.test(m)) return 'CONTENT_REJECTED';
  if (/no face|face not|no speech|no audio|unsupported|too long|duration|resolution|corrupt|invalid/.test(m)) return 'INVALID_INPUT';
  return 'RETRYABLE';
}
