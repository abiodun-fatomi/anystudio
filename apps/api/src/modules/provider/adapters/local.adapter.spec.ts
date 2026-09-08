import { describe, expect, it } from 'vitest';
import { buildArgs } from './local.adapter';

describe('the deterministic stitch timeline', () => {
  it('trims or pads each vendor clip to its planned slot', () => {
    const args = buildArgs(
      {
        shotKeys: ['ws/one.mp4', 'ws/two.mp4'],
        shotDurationsMs: [8_000, 5_000],
        aspect: '9:16',
        captions: [],
        watermark: true,
        preserveShotAudio: false,
      },
      ['/tmp/one.mp4', '/tmp/two.mp4'],
      { out: '/tmp/out.mp4', endStartSec: 13, size: { w: 720, h: 1280 }, timelineMs: [8_000, 5_000] },
    );

    const filters = args[args.indexOf('-filter_complex') + 1]!;
    expect(filters).toContain('tpad=stop_mode=clone:stop_duration=8.000,trim=duration=8.000');
    expect(filters).toContain('tpad=stop_mode=clone:stop_duration=5.000,trim=duration=5.000');
    expect(args[args.indexOf('-t') + 1]).toBe('13.000');
  });

  it('keeps native shot audio and reserves the end card inside the exact target', () => {
    const args = buildArgs(
      {
        shotKeys: ['ws/one.mp4'],
        shotDurationsMs: [6_000],
        targetDurationMs: 8_000,
        preserveShotAudio: true,
        aspect: '16:9',
        captions: [],
        endCard: { text: 'Order now' },
        watermark: true,
      },
      ['/tmp/one.mp4'],
      { out: '/tmp/out.mp4', endStartSec: 6, size: { w: 1280, h: 720 }, timelineMs: [6_000], shotHasAudio: [true] },
    );

    const filters = args[args.indexOf('-filter_complex') + 1]!;
    expect(filters).toContain('[0:a]aresample=48000');
    expect(filters).toContain('concat=n=2:v=1:a=1[vcat][acat]');
    expect(filters).toContain('[acat]loudnorm');
    expect(args[args.indexOf('-t') + 1]).toBe('8.000');
  });

  it('consumes native shot audio when a presenter voiceover and music are also present', () => {
    const args = buildArgs(
      {
        shotKeys: ['ws/presenter.mp4', 'ws/product.mp4'],
        shotDurationsMs: [5_000, 7_000],
        targetDurationMs: 12_000,
        preserveShotAudio: true,
        aspect: '9:16',
        captions: [],
        musicKey: 'ws/music.mp3',
        voiceoverKey: 'ws/presenter.mp3',
        watermark: true,
      },
      ['/tmp/presenter.mp4', '/tmp/product.mp4'],
      {
        musicPath: '/tmp/music.mp3',
        voPath: '/tmp/presenter.mp3',
        out: '/tmp/out.mp4',
        endStartSec: 12,
        size: { w: 720, h: 1280 },
        timelineMs: [5_000, 7_000],
        shotHasAudio: [true, true],
      },
    );

    const filters = args[args.indexOf('-filter_complex') + 1]!;
    expect(filters).toContain('concat=n=2:v=1:a=1[vcat][acat]');
    expect(filters).toContain('[acat]volume=0.80[anative]');
    expect(filters).toContain('[anative][amusic]amix=inputs=2');
    expect(filters).toContain('[abed][voside]sidechaincompress');
    expect(filters).toContain('apad=pad_dur=12.000,atrim=duration=12.000');
  });
});
