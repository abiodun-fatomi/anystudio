/**
 * ElevenLabs — Eleven Music for songs, the multilingual TTS for voiceovers,
 * Dubbing for a video spoken again in another language.
 *
 *   POST https://api.elevenlabs.io/v1/music?output_format=…        → audio bytes
 *   POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}    → audio bytes
 *   POST https://api.elevenlabs.io/v1/dubbing  (multipart)          → { dubbing_id, expected_duration_sec }
 *   GET  https://api.elevenlabs.io/v1/dubbing/{id}                  → { status: dubbing | dubbed | failed, error }
 *   GET  https://api.elevenlabs.io/v1/dubbing/{id}/audio/{lang}     → the dubbed file (MP4 for a video source)
 *
 * And, for a seller's own voice (see voice-lab.ts):
 *
 *   POST https://api.elevenlabs.io/v1/voices/add (multipart)         → { voice_id }        instant voice clone
 *   DELETE https://api.elevenlabs.io/v1/voices/{voice_id}
 *   POST https://api.elevenlabs.io/v1/music/stem-separation (multipart) → a ZIP of stems  (two_stems_v1: vocals + instrumental)
 *   POST https://api.elevenlabs.io/v1/speech-to-speech/{voice_id} (multipart) → audio bytes, the same performance in that voice
 *
 * Dubbing keeps the speaker's own voice (it clones it for the target
 * language) and, by default, the music and ambience under it. It does not
 * move the lips — the DUB pipeline adds that step with a LIPSYNC vendor
 * when asked. Languages are ISO 639-1; see DUB_LANGUAGES for which ones.
 *
 * Music takes either a prompt (instrumental, or the model writes words) or
 * a composition plan of chunks — a section's lyrics, its length and its
 * style words — which is how the seller's own lyrics become the song. The
 * model refuses artist names outright (`bad_prompt`), which is why the
 * genre catalogue's hints describe instruments and rhythm, never people.
 *
 * Endpoint shapes from ElevenLabs' docs, September 2026.
 */

import { ProviderError, dubLanguage, type Capability, type ProviderInput, type ProviderOpts, type ProviderResult } from '@anystudio/shared';
import { BaseProvider } from './base';
import { http, poll } from './http';
import { unzip } from './unzip';
import type { VoiceLab, VoiceSample } from './voice-lab';

const API = 'https://api.elevenlabs.io/v1';

const KNOWN: Record<string, { capability: Capability }> = {
  'elevenlabs:music': { capability: 'MUSIC' },
  'elevenlabs:tts': { capability: 'VOICEOVER' },
  'elevenlabs:dubbing-v1': { capability: 'DUB' },
};

export class ElevenLabsProvider extends BaseProvider implements VoiceLab {
  static all(apiKey: string): ElevenLabsProvider[] {
    return Object.entries(KNOWN).map(([key, k]) => new ElevenLabsProvider(apiKey, key, k.capability));
  }

  constructor(
    private readonly apiKey: string,
    key: string,
    capability: Capability,
  ) {
    super(key, [capability]);
  }

  async generate(input: ProviderInput, opts: ProviderOpts): Promise<ProviderResult> {
    switch (input.capability) {
      case 'MUSIC':
        return this.music(input, opts);
      case 'VOICEOVER':
        return this.speak(input, opts);
      case 'DUB':
        return this.dub(input, opts);
      default:
        return this.unsupported(input.capability);
    }
  }

  private async dub(input: ProviderInput, opts: ProviderOpts): Promise<ProviderResult> {
    const p = this.params(input, 'DUB');
    const lang = dubLanguage(p.targetLanguage)?.elevenlabs;
    if (!lang) throw new ProviderError('INVALID_INPUT', `${this.key}: cannot dub into "${p.targetLanguage}"`, this.key);
    const headers = { 'xi-api-key': this.apiKey };

    // Multipart, by URL: the vendor fetches the signed source itself, so a 200 MB video never passes through the worker twice.
    const form = new FormData();
    form.set('source_url', this.file(input, 'sourceKey'));
    form.set('target_lang', lang);
    form.set('source_lang', p.sourceLanguage && p.sourceLanguage !== 'auto' ? p.sourceLanguage : 'auto');
    form.set('num_speakers', String(p.speakers));
    form.set('watermark', String(this.str(input.config, 'watermark', 'false') === 'true'));
    form.set('highest_resolution', String(this.str(input.config, 'highestResolution', 'true') === 'true'));
    form.set('drop_background_audio', String(!p.keepBackground));
    form.set('name', `anystudio ${input.generationId}`);
    const submitted = await this.multipart<{ dubbing_id?: string; expected_duration_sec?: number; detail?: unknown }>(`${API}/dubbing`, form, headers, opts);
    const providerJobId = submitted.dubbing_id;
    if (!providerJobId) throw new ProviderError('RETRYABLE', `${this.key}: no dubbing_id in response`, this.key, { raw: submitted });
    const expectMs = Math.max(30_000, Math.round((submitted.expected_duration_sec ?? 120) * 1000));
    opts.onProgress?.('ElevenLabs is dubbing', 15);

    const status = await poll(
      async () => {
        const s = await http<{ status?: string; error?: string | null; target_languages?: string[] }>(this.key, `${API}/dubbing/${providerJobId}`, {
          headers,
          timeoutMs: 20_000,
          signal: opts.signal,
        });
        const st = s.json.status ?? '';
        if (st === 'dubbed') return s.json;
        if (st === 'failed' || s.json.error)
          throw new ProviderError(classifyDubError(s.json.error), `${this.key}: dubbing failed: ${s.json.error ?? 'no reason given'}`, this.key, {
            providerJobId,
          });
        return null;
      },
      {
        intervalMs: 8_000,
        timeoutMs: opts.timeoutMs,
        signal: opts.signal,
        onTick: (ms) => opts.onProgress?.(`ElevenLabs is dubbing (${Math.round(ms / 1000)}s)`, Math.min(80, 15 + (ms / expectMs) * 60)),
      },
    ).catch((err) => {
      throw err instanceof ProviderError
        ? err
        : new ProviderError('RETRYABLE', `${this.key}: ${err instanceof Error ? err.message : err}`, this.key, { providerJobId });
    });

    opts.onProgress?.('fetching the dubbed video', 85);
    const { bytes, mime } = await this.download(`${API}/dubbing/${providerJobId}/audio/${encodeURIComponent(lang)}`, headers, opts);
    const isVideo = mime.startsWith('video/') || (!mime.startsWith('audio/') && (input.files.sourceKey?.mime ?? '').startsWith('video/'));
    return {
      providerKey: this.key,
      providerJobId,
      artifacts: [{ bytes, mime: isVideo ? 'video/mp4' : mime || 'audio/mpeg', role: isVideo ? 'video' : 'audio' }],
      // Lips untouched: the pipeline reads this to decide whether a LIPSYNC pass is still owed.
      meta: { language: p.targetLanguage, targetLang: lang, lipsync: false, targetLanguages: status.target_languages ?? [lang] },
    };
  }

  private async music(input: ProviderInput, opts: ProviderOpts): Promise<ProviderResult> {
    const p = this.params(input, 'MUSIC');
    const model = this.str(input.config, 'model', 'music_v2');
    const format = this.str(input.config, 'outputFormat', 'mp3_44100_128');
    const styles = styleWords(p.styleHints, p.mood, p.tempo, p.vocal, p.language);
    const lengthMs = Math.round(p.durationSec * 1000);

    let body: Record<string, unknown>;
    if (p.lyricsText && p.vocal !== 'instrumental') {
      // The seller's words, section by section, with the song's length shared out by how much each section has to say.
      const sections = splitSections(p.lyricsText);
      const totalLines = sections.reduce((s, x) => s + x.lines.length, 0) || 1;
      const chunks = sections.map((s) => ({
        text: `[${s.name}]\n${s.lines.join('\n')}`,
        duration_ms: clamp(Math.round((lengthMs * s.lines.length) / totalLines), 3000, 120_000),
        positive_styles: styles,
        negative_styles: ['spoken word', 'silence'],
        context_adherence: 'high',
      }));
      body = { composition_plan: { chunks }, model_id: model };
    } else {
      body = {
        prompt: [
          p.brief,
          `Style: ${styles.join(', ')}.`,
          p.title ? `Title: ${p.title}.` : '',
          p.vocal === 'instrumental' ? 'Instrumental, no vocals.' : `${p.vocal} vocals, lyrics in ${p.language}.`,
        ]
          .filter(Boolean)
          .join(' '),
        music_length_ms: clamp(lengthMs, 3000, 600_000),
        force_instrumental: p.vocal === 'instrumental',
        model_id: model,
      };
    }
    opts.onProgress?.('composing', 20);
    const bytes = await this.audio(`${API}/music?output_format=${encodeURIComponent(format)}`, body, opts, 'music');
    return {
      providerKey: this.key,
      artifacts: [{ bytes, mime: mimeOf(format), role: 'audio', durationMs: lengthMs }],
      meta: { model, mode: 'composition_plan' in body ? 'plan' : 'prompt' },
    };
  }

  private async speak(input: ProviderInput, opts: ProviderOpts): Promise<ProviderResult> {
    const p = this.params(input, 'VOICEOVER');
    const voiceId = p.providerVoiceId ?? this.str(input.config, 'defaultVoiceId', '21m00Tcm4TlvDq8ikWAM');
    const model = this.str(input.config, 'model', 'eleven_multilingual_v2');
    const format = this.str(input.config, 'outputFormat', 'mp3_44100_128');
    const body: Record<string, unknown> = {
      text: p.script,
      model_id: model,
      voice_settings: {
        stability: p.style === 'energetic' ? 0.3 : p.style === 'calm' ? 0.7 : 0.5,
        similarity_boost: 0.75,
        style: p.style === 'ad' || p.style === 'energetic' ? 0.6 : 0.2,
        use_speaker_boost: true,
        speed: p.speed,
      },
    };
    // The model reads the language from the text; a code is only sent when it is one it accepts.
    if (/^[a-z]{2}$/.test(p.language)) body.language_code = p.language;
    opts.onProgress?.('speaking', 30);
    const bytes = await this.audio(`${API}/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${encodeURIComponent(format)}`, body, opts, 'tts');
    return { providerKey: this.key, artifacts: [{ bytes, mime: mimeOf(format), role: 'audio' }], meta: { model, voiceId } };
  }

  // ---- your own voice -----------------------------------------------------------

  async cloneVoice(input: { name: string; samples: VoiceSample[]; description?: string; labels?: Record<string, string> }, signal?: AbortSignal) {
    const form = new FormData();
    form.set('name', input.name.slice(0, 100));
    if (input.description) form.set('description', input.description.slice(0, 500));
    if (input.labels) form.set('labels', JSON.stringify(input.labels));
    // A phone recording in a room: let the vendor take the room out before it learns the voice.
    form.set('remove_background_noise', 'true');
    for (const s of input.samples) form.append('files', new Blob([s.bytes as unknown as ArrayBuffer], { type: s.mime }), s.filename);
    const res = await this.raw(
      `${API}/voices/add`,
      { method: 'POST', headers: { 'xi-api-key': this.apiKey, accept: 'application/json' }, body: form },
      { timeoutMs: 120_000, signal },
      'voice clone',
    );
    const json = (await res.json()) as { voice_id?: string; requires_verification?: boolean };
    if (!json.voice_id) throw new ProviderError('RETRYABLE', `${this.key}: no voice_id in clone response`, this.key, { raw: json });
    return { providerVoiceId: json.voice_id };
  }

  async deleteVoice(providerVoiceId: string, signal?: AbortSignal): Promise<void> {
    try {
      await this.raw(
        `${API}/voices/${encodeURIComponent(providerVoiceId)}`,
        { method: 'DELETE', headers: { 'xi-api-key': this.apiKey } },
        { timeoutMs: 30_000, signal },
        'voice delete',
      );
    } catch (err) {
      // Already gone is the outcome we wanted.
      if (err instanceof ProviderError && err.meta.status === 404) return;
      throw err;
    }
  }

  async separateStems(audio: VoiceSample, opts: { timeoutMs: number; signal?: AbortSignal }) {
    const form = new FormData();
    form.set('file', new Blob([audio.bytes as unknown as ArrayBuffer], { type: audio.mime }), audio.filename);
    form.set('stem_variation_id', 'two_stems_v1');
    form.set('output_format', 'mp3_44100_128');
    const res = await this.raw(
      `${API}/music/stem-separation`,
      { method: 'POST', headers: { 'xi-api-key': this.apiKey, accept: 'application/zip' }, body: form },
      { timeoutMs: opts.timeoutMs, signal: opts.signal },
      'stem separation',
    );
    const zip = new Uint8Array(await res.arrayBuffer());
    let entries: ReturnType<typeof unzip>;
    try {
      entries = unzip(zip).filter((e) => /\.(mp3|wav|flac|ogg)$/i.test(e.name));
    } catch (err) {
      throw new ProviderError('RETRYABLE', `${this.key}: stems came back unreadable: ${err instanceof Error ? err.message : err}`, this.key);
    }
    const isVocal = (n: string) => /vocal|voice|sing/i.test(n) && !/no[_ -]?vocal|instrument|accomp|backing/i.test(n);
    const vocals = entries.find((e) => isVocal(e.name.split('/').pop() ?? e.name));
    const instrumental = entries.find((e) => e !== vocals);
    if (!vocals || !instrumental)
      throw new ProviderError(
        'RETRYABLE',
        `${this.key}: expected a vocal and an instrumental stem, got ${entries.map((e) => e.name).join(', ') || 'nothing'}`,
        this.key,
      );
    return { vocals: vocals.bytes, instrumental: instrumental.bytes, mime: 'audio/mpeg' };
  }

  async convertVoice(providerVoiceId: string, audio: VoiceSample, opts: { timeoutMs: number; signal?: AbortSignal; language?: string }) {
    const form = new FormData();
    form.set('audio', new Blob([audio.bytes as unknown as ArrayBuffer], { type: audio.mime }), audio.filename);
    form.set('model_id', 'eleven_multilingual_sts_v2');
    form.set('remove_background_noise', 'false');
    // Similarity high, stability middling: it is their voice we want, on the model's melody.
    form.set('voice_settings', JSON.stringify({ stability: 0.45, similarity_boost: 0.9, style: 0.15, use_speaker_boost: true }));
    const res = await this.raw(
      `${API}/speech-to-speech/${encodeURIComponent(providerVoiceId)}?output_format=mp3_44100_128`,
      { method: 'POST', headers: { 'xi-api-key': this.apiKey, accept: 'audio/mpeg' }, body: form },
      { timeoutMs: opts.timeoutMs, signal: opts.signal },
      'voice conversion',
    );
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength < 1000) throw new ProviderError('RETRYABLE', `${this.key}: voice conversion returned ${bytes.byteLength} bytes`, this.key);
    return { bytes, mime: 'audio/mpeg' };
  }

  /** ElevenLabs bills these in characters-equivalent credits; the figures are the Pro-plan cents, rounded up. */
  voiceLabCostMinor(step: 'clone' | 'stems' | 'convert', seconds: number): number {
    if (step === 'clone') return 0;
    if (step === 'stems') return Math.ceil(seconds / 60) * 10;
    return Math.ceil(seconds) * 2;
  }

  /** POST JSON and take the bytes. */
  private async audio(url: string, body: unknown, opts: ProviderOpts, what: string): Promise<Uint8Array> {
    const res = await this.raw(
      url,
      { method: 'POST', headers: { 'xi-api-key': this.apiKey, 'content-type': 'application/json', accept: 'audio/mpeg' }, body: JSON.stringify(body) },
      opts,
      what,
    );
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength < 1000) throw new ProviderError('RETRYABLE', `${this.key}: ${what} returned ${buf.byteLength} bytes`, this.key);
    return buf;
  }

  /** POST a form (the dubbing endpoint), take the JSON. */
  private async multipart<T>(url: string, form: FormData, headers: Record<string, string>, opts: ProviderOpts): Promise<T> {
    const res = await this.raw(
      url,
      { method: 'POST', headers: { ...headers, accept: 'application/json' }, body: form },
      { ...opts, timeoutMs: Math.min(opts.timeoutMs, 120_000) },
      'dubbing',
    );
    return (await res.json()) as T;
  }

  /** GET a finished file; what comes back may be video or audio. */
  private async download(url: string, headers: Record<string, string>, opts: ProviderOpts): Promise<{ bytes: Uint8Array; mime: string }> {
    const res = await this.raw(url, { method: 'GET', headers }, { ...opts, timeoutMs: Math.min(opts.timeoutMs, 300_000) }, 'download');
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength < 1000) throw new ProviderError('RETRYABLE', `${this.key}: download returned ${bytes.byteLength} bytes`, this.key);
    return { bytes, mime: res.headers.get('content-type')?.split(';')[0]?.trim() ?? '' };
  }

  /** One fetch with the vendor's error vocabulary mapped: `detail.status` slugs and the usual status codes. */
  private async raw(url: string, init: RequestInit, opts: ProviderOpts, what: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    opts.signal?.addEventListener('abort', () => controller.abort(), { once: true });
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      clearTimeout(timer);
      throw new ProviderError('RETRYABLE', `${this.key}: network error on ${what}: ${err instanceof Error ? err.message : err}`, this.key);
    }
    clearTimeout(timer);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let slug = '';
      try {
        slug = String((JSON.parse(text) as { detail?: { status?: string } }).detail?.status ?? '');
      } catch {
        /* not json */
      }
      const kind =
        res.status === 429
          ? 'RATE_LIMITED'
          : slug === 'bad_prompt' || slug === 'bad_composition_plan' || slug === 'dubbing_content_moderation' || res.status === 422
            ? 'CONTENT_REJECTED'
            : res.status === 401 || res.status === 402 || res.status === 403
              ? 'PROVIDER_DOWN'
              : res.status >= 500
                ? 'RETRYABLE'
                : 'INVALID_INPUT';
      throw new ProviderError(kind, `${this.key}: HTTP ${res.status} on ${what}${slug ? ` (${slug})` : ''}: ${text.slice(0, 300)}`, this.key, {
        status: res.status,
      });
    }
    return res;
  }
}

/** A failed dub is the vendor's problem unless its reason names the content. */
export function classifyDubError(error: string | null | undefined): 'CONTENT_REJECTED' | 'INVALID_INPUT' | 'RETRYABLE' {
  const e = (error ?? '').toLowerCase();
  if (/moderation|policy|prohibited|inappropriate/.test(e)) return 'CONTENT_REJECTED';
  if (/no speech|no audio|could not detect|unsupported|too long|too short|corrupt/.test(e)) return 'INVALID_INPUT';
  return 'RETRYABLE';
}

/** The style words a genre row carries, plus what the seller chose. */
export function styleWords(hints: string | undefined, mood?: string, tempo?: string, vocal?: string, language?: string): string[] {
  const words = (hints ?? '')
    .split(/[,;]\s*|\s+—\s+/)
    .map((w) => w.trim())
    .filter(Boolean);
  if (mood) words.push(mood);
  if (tempo) words.push(tempo === 'fast' ? 'fast tempo' : tempo === 'slow' ? 'slow tempo' : 'mid tempo');
  if (vocal && vocal !== 'instrumental') words.push(`${vocal} vocals`);
  if (vocal === 'instrumental') words.push('instrumental');
  if (language && language !== 'en' && vocal !== 'instrumental') words.push(`lyrics in ${language}`);
  return [...new Set(words)].slice(0, 50);
}

/** "[Verse]\nl1\nl2\n\n[Chorus]\n…" → sections. Untagged text becomes one verse. */
export function splitSections(text: string): Array<{ name: string; lines: string[] }> {
  const out: Array<{ name: string; lines: string[] }> = [];
  let current: { name: string; lines: string[] } | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const tag = /^\[([^\]]+)\]$/.exec(line);
    if (tag) {
      current = { name: tag[1]!, lines: [] };
      out.push(current);
      continue;
    }
    if (!line) continue;
    if (!current) {
      current = { name: 'Verse', lines: [] };
      out.push(current);
    }
    current.lines.push(line);
  }
  return out.filter((s) => s.lines.length > 0);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
function mimeOf(format: string): string {
  return format.startsWith('mp3')
    ? 'audio/mpeg'
    : format.startsWith('wav') || format.startsWith('pcm')
      ? 'audio/wav'
      : format.startsWith('opus')
        ? 'audio/ogg'
        : 'audio/mpeg';
}
