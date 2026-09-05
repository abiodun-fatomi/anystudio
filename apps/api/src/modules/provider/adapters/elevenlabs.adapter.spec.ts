import { describe, expect, it } from 'vitest';
import { splitSections, styleWords } from './elevenlabs.adapter';
import { cutPreview } from '../../../worker/pipelines/music';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

describe('lyrics sections', () => {
  it('splits tagged lyrics and treats untagged text as one verse', () => {
    expect(splitSections('[Verse]\nline one\nline two\n\n[Chorus]\nhook\nhook')).toEqual([{ name: 'Verse', lines: ['line one', 'line two'] }, { name: 'Chorus', lines: ['hook', 'hook'] }]);
    expect(splitSections('just words\nmore words')).toEqual([{ name: 'Verse', lines: ['just words', 'more words'] }]);
    expect(splitSections('[Intro]\n\n[Verse]\nx')).toEqual([{ name: 'Verse', lines: ['x'] }]);
  });
});

describe('style words', () => {
  it('turns the genre hints and the choices into a de-duplicated list under fifty', () => {
    const w = styleWords('log drum bassline, soft jazzy piano chords, shakers', 'joyful', 'fast', 'female', 'yo');
    expect(w).toContain('log drum bassline');
    expect(w).toContain('female vocals');
    expect(w).toContain('fast tempo');
    expect(w).toContain('lyrics in yo');
    expect(styleWords('a, b', undefined, undefined, 'instrumental', 'yo')).toEqual(['a', 'b', 'instrumental']);
  });
});

describe('preview cut', () => {
  it('cuts the first seconds of a track to MP3 and reports the full length', async () => {
    // Six seconds of tone, so the preview is shorter than the whole.
    const { stdout } = await exec('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-c:a', 'libmp3lame', '-f', 'mp3', 'pipe:1'], { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 });
    const { preview, fullMs } = await cutPreview(new Uint8Array(stdout), 'mp3', 3);
    expect(fullMs).toBeGreaterThan(5500);
    expect(preview.byteLength).toBeGreaterThan(1000);
    // ID3/MPEG frame sync at the start: it is an MP3.
    expect(preview[0] === 0x49 || preview[0] === 0xff).toBe(true);
    const { writeFile, mkdtemp, rm } = await import('node:fs/promises');
    const dir = await mkdtemp('/tmp/pv-');
    await writeFile(`${dir}/p.mp3`, preview);
    const probe = await exec('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', `${dir}/p.mp3`]);
    expect(parseFloat(probe.stdout)).toBeGreaterThan(2.8);
    expect(parseFloat(probe.stdout)).toBeLessThan(3.3);
    await rm(dir, { recursive: true, force: true });
  }, 30_000);
});
