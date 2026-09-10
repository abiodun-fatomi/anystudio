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
import {
  fetchBytes,
  http,
  kindForStatus,
  linkedTimeoutSignal,
  MAX_PROVIDER_JSON_BYTES,
  MAX_PROVIDER_OUTPUT_BYTES,
  poll,
  readLimitedResponseBytes,
} from './http';

interface Video {
  id: string;
  status: 'queued' | 'in_progress' | 'completed' | 'failed';
  progress?: number;
  error?: { message: string; code?: string };
}

const KNOWN: Record<string, { capability: Capability; model: string }> = {
  'openai:sora-2': { capability: 'IMAGE_TO_VIDEO', model: 'sora-2' },
  'openai:tts': { capability: 'VOICEOVER', model: 'gpt-4o-mini-tts' },
};

/** OpenAI's published permanent shutdown time, treated conservatively as the start of the stated UTC date. */
export const SORA_API_SHUTDOWN_AT = Date.parse('2026-09-24T00:00:00.000Z');

export function soraApiAvailable(now = Date.now()): boolean {
  return now < SORA_API_SHUTDOWN_AT;
}

export function soraSize(aspect: '1:1' | '4:5' | '9:16' | '16:9' | '3:4'): '1280x720' | '720x1280' {
  return aspect === '16:9' ? '1280x720' : '720x1280';
}

export class OpenAiProvider extends BaseProvider {
  static all(apiKey: string, now = Date.now()): OpenAiProvider[] {
    return Object.entries(KNOWN)
      .filter(([key]) => key !== 'openai:sora-2' || soraApiAvailable(now))
      .map(([key, k]) => new OpenAiProvider(apiKey, key, k.capability, k.model));
  }

  constructor(
    private readonly apiKey: string,
    key: string,
    capability: Capability,
    private readonly defaultModel: string,
  ) {
    super(key, [capability]);
  }

  async generate(input: ProviderInput, opts: ProviderOpts): Promise<ProviderResult> {
    if (input.capability === 'VOICEOVER') return this.speak(input, opts);
    if (input.capability !== 'IMAGE_TO_VIDEO') this.unsupported(input.capability);
    // A worker can stay alive across the shutdown boundary, so registration-
    // time filtering alone is insufficient. Fail locally and let the runner
    // continue to Wan/Veo instead of sending a doomed OpenAI request.
    if (!soraApiAvailable())
      throw new ProviderError('PROVIDER_DOWN', 'openai:sora-2: the Sora API has been retired', this.key, { submissionState: 'NOT_STARTED' });
    const p = this.params(input, 'IMAGE_TO_VIDEO');
    const model = this.str(input.config, 'model', this.defaultModel);
    const auth = { authorization: `Bearer ${this.apiKey}` };
    let providerJobId: string;
    if (opts.resume) {
      providerJobId = opts.resume.providerJobId;
    } else {
      const source = await fetchBytes(this.key, this.file(input, 'sourceKey'), Math.min(opts.timeoutMs, 60_000), opts.signal);
      const form = new FormData();
      form.set('model', model);
      form.set('prompt', p.motion ? `${p.prompt}. Camera: ${p.motion}` : p.prompt);
      form.set('seconds', String(p.durationSec <= 5 ? 4 : 8));
      // Sora accepts portrait or landscape rather than arbitrary dimensions.
      // The requested aspect chooses the orientation; provider-row config must
      // not force every job into portrait.
      form.set('size', soraSize(p.aspect));
      form.set('input_reference', new Blob([source.bytes], { type: source.mime }), 'reference.png');

      const submitSignal = linkedTimeoutSignal(opts.signal, Math.min(opts.timeoutMs, 60_000));
      let createdText: string;
      let createdStatus: number;
      try {
        const created = await fetch('https://api.openai.com/v1/videos', { method: 'POST', headers: auth, body: form, signal: submitSignal.signal });
        createdStatus = created.status;
        createdText = new TextDecoder().decode(await readLimitedResponseBytes(this.key, created, MAX_PROVIDER_JSON_BYTES, 'video submission response'));
        if (!created.ok) {
          const kind = created.status === 400 && /moderation|policy|safety/i.test(createdText) ? 'CONTENT_REJECTED' : kindForStatus(created.status);
          throw new ProviderError(kind, `${this.key}: HTTP ${created.status}: ${createdText.slice(0, 400)}`, this.key, { status: created.status });
        }
      } catch (err) {
        if (err instanceof ProviderError) throw err;
        throw new ProviderError('RETRYABLE', `${this.key}: ${err instanceof Error ? err.message : err}`, this.key);
      } finally {
        submitSignal.dispose();
      }
      const video = JSON.parse(createdText) as Video;
      providerJobId = video.id;
      if (!providerJobId) throw new ProviderError('RETRYABLE', `${this.key}: create response had no video id`, this.key, { status: createdStatus, raw: video });
      await opts.onSubmitted?.(providerJobId);
    }
    opts.onProgress?.('Rendering your video', 20);

    const final = await poll(
      async () => {
        const s = await http<Video>(this.key, `https://api.openai.com/v1/videos/${providerJobId}`, { headers: auth, timeoutMs: 20_000, signal: opts.signal });
        if (s.json.status === 'completed' || s.json.status === 'failed') return s.json;
        if (s.json.progress !== undefined) opts.onProgress?.(`Rendering your video (${s.json.progress}%)`, 20 + s.json.progress * 0.6);
        return null;
      },
      { intervalMs: 8_000, timeoutMs: opts.timeoutMs, signal: opts.signal },
    );
    if (final.status !== 'completed') {
      const msg = final.error?.message ?? 'failed';
      await opts.onSettled?.('FAILED');
      throw new ProviderError(/moderation|policy|safety/i.test(msg) ? 'CONTENT_REJECTED' : 'RETRYABLE', `${this.key}: ${msg}`, this.key, { providerJobId });
    }

    const downloadSignal = linkedTimeoutSignal(opts.signal, Math.min(opts.timeoutMs, 120_000));
    let bytes: Uint8Array;
    try {
      const res = await fetch(`https://api.openai.com/v1/videos/${providerJobId}/content`, { headers: auth, signal: downloadSignal.signal });
      if (!res.ok) throw new ProviderError(kindForStatus(res.status), `${this.key}: could not download video (${res.status})`, this.key, { providerJobId });
      bytes = await readLimitedResponseBytes(this.key, res, MAX_PROVIDER_OUTPUT_BYTES, 'video download');
    } finally {
      downloadSignal.dispose();
    }
    return { providerKey: this.key, providerJobId, artifacts: [{ bytes, mime: 'video/mp4', role: 'video' }], meta: { model } };
  }

  /**
   * POST /v1/audio/speech — one request, the MP3 back. `instructions` steer
   * delivery on the gpt-4o-mini-tts model; the older tts-1 ignores them.
   */
  private async speak(input: ProviderInput, opts: ProviderOpts): Promise<ProviderResult> {
    const p = this.params(input, 'VOICEOVER');
    const model = this.str(input.config, 'model', this.defaultModel);
    const voice = p.providerVoiceId ?? this.str(input.config, 'defaultVoice', 'nova');
    const instructions: Record<string, string> = {
      natural: 'Speak naturally and clearly.',
      ad: 'Speak like a confident, warm radio advert voice; energetic but not shouting.',
      calm: 'Speak slowly, calmly and warmly.',
      energetic: 'Speak with bright, upbeat energy and a smile in the voice.',
      story: 'Narrate like a story, with feeling and gentle pacing.',
    };
    const requestSignal = linkedTimeoutSignal(opts.signal, opts.timeoutMs);
    let bytes: Uint8Array;
    try {
      const res = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          voice,
          input: p.script,
          response_format: 'mp3',
          speed: p.speed,
          ...(model.includes('4o') ? { instructions: `${instructions[p.style] ?? instructions.natural} Language: ${p.language}.` } : {}),
        }),
        signal: requestSignal.signal,
      });
      if (!res.ok) {
        const text = new TextDecoder().decode(
          await readLimitedResponseBytes(this.key, res, MAX_PROVIDER_JSON_BYTES, 'speech error response').catch(() => new Uint8Array()),
        );
        throw new ProviderError(kindForStatus(res.status), `${this.key}: HTTP ${res.status}: ${text.slice(0, 300)}`, this.key, { status: res.status });
      }
      bytes = await readLimitedResponseBytes(this.key, res, MAX_PROVIDER_OUTPUT_BYTES, 'speech response');
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError('RETRYABLE', `${this.key}: network error: ${err instanceof Error ? err.message : err}`, this.key);
    } finally {
      requestSignal.dispose();
    }
    return { providerKey: this.key, artifacts: [{ bytes, mime: 'audio/mpeg', role: 'audio' }], meta: { model, voice } };
  }
}
