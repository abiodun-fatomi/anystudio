/**
 * ElevenLabs — Eleven Music for songs, the multilingual TTS for voiceovers.
 *
 *   POST https://api.elevenlabs.io/v1/music?output_format=…        → audio bytes
 *   POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}    → audio bytes
 *
 * Music takes either a prompt (instrumental, or the model writes words) or
 * a composition plan of chunks — a section's lyrics, its length and its
 * style words — which is how the seller's own lyrics become the song. The
 * model refuses artist names outright (`bad_prompt`), which is why the
 * genre catalogue's hints describe instruments and rhythm, never people.
 *
 * Endpoint shapes from ElevenLabs' docs, September 2026.
 */

import { ProviderError, type Capability, type ProviderInput, type ProviderOpts, type ProviderResult } from '@anystudio/shared';
import { BaseProvider } from './base';

const API = 'https://api.elevenlabs.io/v1';

const KNOWN: Record<string, { capability: Capability }> = {
  'elevenlabs:music': { capability: 'MUSIC' },
  'elevenlabs:tts': { capability: 'VOICEOVER' },
};

export class ElevenLabsProvider extends BaseProvider {
  static all(apiKey: string): ElevenLabsProvider[] {
    return Object.entries(KNOWN).map(([key, k]) => new ElevenLabsProvider(apiKey, key, k.capability));
  }

  constructor(private readonly apiKey: string, key: string, capability: Capability) {
    super(key, [capability]);
  }

  async generate(input: ProviderInput, opts: ProviderOpts): Promise<ProviderResult> {
    switch (input.capability) {
      case 'MUSIC': return this.music(input, opts);
      case 'VOICEOVER': return this.speak(input, opts);
      default: return this.unsupported(input.capability);
    }
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
        prompt: [p.brief, `Style: ${styles.join(', ')}.`, p.title ? `Title: ${p.title}.` : '', p.vocal === 'instrumental' ? 'Instrumental, no vocals.' : `${p.vocal} vocals, lyrics in ${p.language}.`].filter(Boolean).join(' '),
        music_length_ms: clamp(lengthMs, 3000, 600_000),
        force_instrumental: p.vocal === 'instrumental',
        model_id: model,
      };
    }
    opts.onProgress?.('composing', 20);
    const bytes = await this.audio(`${API}/music?output_format=${encodeURIComponent(format)}`, body, opts, 'music');
    return { providerKey: this.key, artifacts: [{ bytes, mime: mimeOf(format), role: 'audio', durationMs: lengthMs }], meta: { model, mode: 'composition_plan' in body ? 'plan' : 'prompt' } };
  }

  private async speak(input: ProviderInput, opts: ProviderOpts): Promise<ProviderResult> {
    const p = this.params(input, 'VOICEOVER');
    const voiceId = p.providerVoiceId ?? this.str(input.config, 'defaultVoiceId', '21m00Tcm4TlvDq8ikWAM');
    const model = this.str(input.config, 'model', 'eleven_multilingual_v2');
    const format = this.str(input.config, 'outputFormat', 'mp3_44100_128');
    const body: Record<string, unknown> = {
      text: p.script,
      model_id: model,
      voice_settings: { stability: p.style === 'energetic' ? 0.3 : p.style === 'calm' ? 0.7 : 0.5, similarity_boost: 0.75, style: p.style === 'ad' || p.style === 'energetic' ? 0.6 : 0.2, use_speaker_boost: true, speed: p.speed },
    };
    // The model reads the language from the text; a code is only sent when it is one it accepts.
    if (/^[a-z]{2}$/.test(p.language)) body.language_code = p.language;
    opts.onProgress?.('speaking', 30);
    const bytes = await this.audio(`${API}/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${encodeURIComponent(format)}`, body, opts, 'tts');
    return { providerKey: this.key, artifacts: [{ bytes, mime: mimeOf(format), role: 'audio' }], meta: { model, voiceId } };
  }

  /** POST and take the bytes; vendor errors come back as JSON with a `detail.status` slug. */
  private async audio(url: string, body: unknown, opts: ProviderOpts, what: string): Promise<Uint8Array> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    opts.signal?.addEventListener('abort', () => controller.abort(), { once: true });
    let res: Response;
    try {
      res = await fetch(url, { method: 'POST', headers: { 'xi-api-key': this.apiKey, 'content-type': 'application/json', accept: 'audio/mpeg' }, body: JSON.stringify(body), signal: controller.signal });
    } catch (err) {
      clearTimeout(timer);
      throw new ProviderError('RETRYABLE', `${this.key}: network error on ${what}: ${err instanceof Error ? err.message : err}`, this.key);
    }
    clearTimeout(timer);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let slug = '';
      try { slug = String((JSON.parse(text) as { detail?: { status?: string } }).detail?.status ?? ''); } catch { /* not json */ }
      const kind = res.status === 429 ? 'RATE_LIMITED'
        : slug === 'bad_prompt' || slug === 'bad_composition_plan' || res.status === 422 ? 'CONTENT_REJECTED'
          : res.status === 401 || res.status === 402 || res.status === 403 ? 'PROVIDER_DOWN'
            : res.status >= 500 ? 'RETRYABLE' : 'INVALID_INPUT';
      throw new ProviderError(kind, `${this.key}: HTTP ${res.status} on ${what}${slug ? ` (${slug})` : ''}: ${text.slice(0, 300)}`, this.key, { status: res.status });
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength < 1000) throw new ProviderError('RETRYABLE', `${this.key}: ${what} returned ${buf.byteLength} bytes`, this.key);
    return buf;
  }
}

/** The style words a genre row carries, plus what the seller chose. */
export function styleWords(hints: string | undefined, mood?: string, tempo?: string, vocal?: string, language?: string): string[] {
  const words = (hints ?? '').split(/[,;]\s*|\s+—\s+/).map((w) => w.trim()).filter(Boolean);
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
    if (tag) { current = { name: tag[1]!, lines: [] }; out.push(current); continue; }
    if (!line) continue;
    if (!current) { current = { name: 'Verse', lines: [] }; out.push(current); }
    current.lines.push(line);
  }
  return out.filter((s) => s.lines.length > 0);
}

function clamp(v: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, v)); }
function mimeOf(format: string): string { return format.startsWith('mp3') ? 'audio/mpeg' : format.startsWith('wav') || format.startsWith('pcm') ? 'audio/wav' : format.startsWith('opus') ? 'audio/ogg' : 'audio/mpeg'; }
