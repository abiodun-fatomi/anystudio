/**
 * A song: words first, then music, then a preview the seller can hear
 * before paying for the rest — the Frobits loop, made channel-agnostic so
 * the web studio and the WhatsApp bot share it.
 *
 *   1. LYRICS. If the seller gave none and wants vocals, the copy model
 *      writes them in the chosen language, structured by section, from the
 *      brief and the genre. Written onto the row (`lyricsWritten`) before
 *      the music call, so a retry never writes a second set.
 *   2. MUSIC. The genre row's hints (instruments, rhythm, delivery — never a
 *      name) plus the lyrics go to the music provider. Full length, once.
 *   3. THE VAULT. The full track is stored under the workspace's vault
 *      prefix, which the API refuses to sign. The output is marked locked.
 *   4. THE PREVIEW. ffmpeg cuts the first thirty seconds with a fade and a
 *      quiet spoken tag is NOT added — a fade is enough, and a tag would
 *      make the preview useless as a Status clip, which is half the point.
 *
 * The preview is what the request paid for (audio.music.preview); unlocking
 * (audio.music.unlock) copies the track out of the vault. See AudioService.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  ProviderError,
  lyricsSchema,
  lyricsToText,
  LYRICS_JSON_SCHEMA,
  MUSIC_PREVIEW_SEC,
  type CapabilityParams,
  type LlmRequest,
  type Lyrics,
  type ProviderArtifact,
} from '@anystudio/shared';
import type { Pipeline, PipelineContext, PipelineResult } from './index';
import { MediaService } from '../../modules/media/media.service';
import { fetchBytes } from '../../modules/provider/adapters/http';

const exec = promisify(execFile);

export const musicPipeline: Pipeline = async (ctx) => {
  const p = ctx.row.input as CapabilityParams<'MUSIC'>;
  const genre = await ctx.db.musicGenre.findUnique({ where: { key: p.genre } });
  if (!genre) throw new ProviderError('INVALID_INPUT', `unknown genre "${p.genre}"`, 'music-pipeline');

  // ---- 1. words
  let lyricsText: string | undefined = p.lyrics?.trim() || p.lyricsWritten || undefined;
  let lyrics: Lyrics | null = null;
  let lyricsCost = 0;
  if (p.vocal !== 'instrumental' && !lyricsText) {
    await ctx.stage('preparing', 8, 'writing the words');
    const written = await writeLyrics(ctx, p, genre.name, genre.promptHints);
    lyrics = written.lyrics;
    lyricsCost = written.costMinor ?? 0;
    lyricsText = lyricsToText(lyrics);
    await ctx.db.generation.update({
      where: { id: ctx.row.id },
      data: { input: { ...(ctx.row.input as object), lyricsWritten: lyricsText, title: p.title ?? lyrics.title } },
    });
    ctx.log.info({ sections: lyrics.sections.length, title: lyrics.title }, 'lyrics written');
  }

  // ---- 2. the track
  await ctx.stage('generating', 20, `composing ${genre.name}`);
  const result = await ctx.callProvider(
    {
      generationId: ctx.row.id,
      workspaceId: ctx.row.workspaceId,
      capability: 'MUSIC',
      files: ctx.files,
      params: { ...p, styleHints: genre.promptHints, lyricsText, title: p.title ?? lyrics?.title },
    },
    {
      timeoutMs: ctx.budgetMs,
      signal: ctx.signal,
      onProgress: (detail, progress) => void ctx.stage('generating', Math.max(20, Math.min(70, progress ?? 40)), detail),
    },
  );
  const track = result.artifacts.find((a) => a.role === 'audio');
  if (!track) throw new ProviderError('RETRYABLE', `${result.providerKey} returned no audio`, result.providerKey);
  const bytes = track.bytes ?? (track.url ? (await fetchBytes(result.providerKey, track.url, 120_000)).bytes : undefined);
  if (!bytes) throw new ProviderError('RETRYABLE', `${result.providerKey} returned an audio artifact with no bytes`, result.providerKey);

  // ---- 3 + 4. vault the whole thing, cut the preview
  await ctx.stage('storing', 80, 'cutting the preview');
  const ext = track.mime === 'audio/wav' ? 'wav' : 'mp3';
  const fullKey = MediaService.vaultKey(ctx.row.workspaceId, `gen/${ctx.row.id}`, `song.${ext}`, ctx.row.createdAt);
  await ctx.media.put(fullKey, bytes, track.mime);
  await ctx.media.recordOutput({
    workspaceId: ctx.row.workspaceId,
    generationId: ctx.row.id,
    key: fullKey,
    kind: 'OUTPUT',
    mime: track.mime,
    bytes: bytes.byteLength,
    durationMs: track.durationMs,
  });
  const { preview, fullMs } = await cutPreview(bytes, ext, MUSIC_PREVIEW_SEC);

  const artifacts: ProviderArtifact[] = [
    // The preview goes through storeArtifacts like any output; the locked track is already stored and is described, not uploaded.
    { bytes: preview, mime: 'audio/mpeg', role: 'preview', durationMs: Math.min(fullMs, MUSIC_PREVIEW_SEC * 1000) },
    {
      text: { title: p.title ?? lyrics?.title ?? null, lyrics: lyricsText ?? null, genre: genre.name, vocal: p.vocal, language: p.language },
      mime: 'application/json',
      role: 'text',
    },
  ];
  return {
    artifacts,
    providerKey: result.providerKey,
    providerJobId: result.providerJobId,
    costMinor: (result.costMinor ?? 0) + lyricsCost,
    // Reported back to the runner as a pre-stored output; see runner.ts `extraOutputs`.
    extraOutputs: [{ key: fullKey, role: 'audio', mime: track.mime, bytes: bytes.byteLength, durationMs: fullMs, locked: true }],
  } as PipelineResult;
};

async function writeLyrics(
  ctx: PipelineContext,
  p: CapabilityParams<'MUSIC'>,
  genreName: string,
  hints: string,
): Promise<{ lyrics: Lyrics; costMinor?: number }> {
  const profile = (ctx.workspace.profile as Record<string, unknown> | null) ?? {};
  const language = LANGUAGE_NAME[p.language] ?? p.language;
  const targetSections =
    p.durationSec >= 150
      ? 'intro, verse, pre-chorus, chorus, verse, chorus, bridge, chorus, outro'
      : p.durationSec >= 90
        ? 'verse, chorus, verse, chorus, bridge, chorus'
        : 'verse, chorus, verse, chorus';
  const system = [
    `You are a songwriter. Write original lyrics for a ${genreName} song, to be sung by a music model. Write in ${language}.`,
    `The genre sounds like: ${hints}. Match its phrasing and rhythm — short lines that scan when sung, a chorus that repeats a hook.`,
    p.vocal === 'duet'
      ? 'Two voices: mark lines for the second voice in a verse with "(2)".'
      : p.vocal === 'choir'
        ? 'Written for a choir: simple, repeated, singable lines.'
        : '',
    p.mood ? `Mood: ${p.mood}.` : '',
    `Sections in this order: ${targetSections}. Two to six lines per section; the chorus is the same words each time.`,
    profile.sells
      ? `The seller sells: ${String(profile.sells)}. If the brief is about their business, make it feel like a real song, not a jingle — unless they ask for a jingle.`
      : '',
    'Never name a real artist, band or existing song. Never copy a known lyric. Keep every line under 12 words.',
    'Return only the structure requested.',
  ]
    .filter(Boolean)
    .join('\n');
  const parts: LlmRequest['parts'] = [
    { text: [p.title ? `Title: ${p.title}` : 'Choose a short title.', `What the song is about: ${p.brief}`, 'Write the lyrics now.'].join('\n') },
  ];
  const request: LlmRequest = { system, parts, jsonSchema: LYRICS_JSON_SCHEMA, maxTokens: 1500, temperature: 0.9 };

  let issues: string | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const req: LlmRequest = issues
      ? {
          ...request,
          parts: [
            ...request.parts,
            { text: `Your previous answer did not fit the required structure:\n${issues}\nAnswer again, fixing exactly those problems.` },
          ],
        }
      : request;
    const r = await ctx.callCapability(
      'TEXT_GENERATE',
      { generationId: ctx.row.id, workspaceId: ctx.row.workspaceId, params: { task: 'lyrics', language: p.language }, files: {}, prompt: req },
      { timeoutMs: 60_000, signal: ctx.signal },
    );
    const parsed = lyricsSchema.safeParse(r.artifacts.find((a) => a.text !== undefined)?.text);
    if (parsed.success) return { lyrics: parsed.data, costMinor: r.costMinor };
    issues = parsed.error.issues.map((i) => `- ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    ctx.log.warn({ attempt, issues }, 'lyrics did not fit the schema; asking again');
  }
  throw new ProviderError('RETRYABLE', `lyrics failed schema validation twice: ${issues}`, 'music-pipeline');
}

/** The first N seconds as MP3 with a two-second fade, plus the real length of the whole track. */
export async function cutPreview(bytes: Uint8Array, ext: string, seconds: number): Promise<{ preview: Uint8Array; fullMs: number }> {
  const dir = await mkdtemp(join(tmpdir(), 'preview-'));
  try {
    const src = join(dir, `song.${ext}`);
    const out = join(dir, 'preview.mp3');
    await writeFile(src, bytes);
    let fullMs = 0;
    try {
      const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', src]);
      fullMs = Math.round(parseFloat(stdout.trim()) * 1000) || 0;
    } catch {
      /* unknown length is not fatal */
    }
    const fadeAt = Math.max(0, seconds - 2);
    await exec(
      'ffmpeg',
      ['-v', 'error', '-y', '-i', src, '-t', String(seconds), '-af', `afade=t=out:st=${fadeAt}:d=2`, '-c:a', 'libmp3lame', '-b:a', '128k', out],
      { maxBuffer: 32 * 1024 * 1024 },
    );
    return { preview: new Uint8Array(await readFile(out)), fullMs };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const LANGUAGE_NAME: Record<string, string> = {
  en: 'English',
  'en-NG': 'Nigerian English',
  pcm: 'Nigerian Pidgin',
  yo: 'Yoruba (with tone marks)',
  ig: 'Igbo',
  ha: 'Hausa',
  tw: 'Twi',
  sw: 'Swahili',
  zu: 'Zulu',
  xh: 'Xhosa',
  fr: 'French',
  pt: 'Portuguese',
  es: 'Spanish',
  ar: 'Arabic',
  hi: 'Hindi',
  pa: 'Punjabi',
  ko: 'Korean',
  ja: 'Japanese',
  zh: 'Mandarin Chinese',
  vi: 'Vietnamese',
  tr: 'Turkish',
  am: 'Amharic',
  ln: 'Lingala',
  wo: 'Wolof',
};
