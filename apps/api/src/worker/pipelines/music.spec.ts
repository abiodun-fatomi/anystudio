import { describe, expect, it } from 'vitest';
import { looksComplete, looksLikeProse, seedMode } from './music';

describe('what the seller wrote is for', () => {
  it('sings marked-up or long lyrics exactly', () => {
    expect(seedMode('[Verse]\nline one\nline two\n[Chorus]\nhook', 'auto')).toBe('exact');
    expect(looksComplete(Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n'))).toBe(true);
  });

  it('writes the song from a story or a memory', () => {
    const story =
      'My mother started this shop in Balogun market in 1998 with one table of fabric. I grew up folding ankara after school. Last month we opened our second shop and she cried at the door.';
    expect(looksLikeProse(story)).toBe(true);
    expect(seedMode(story, 'auto')).toBe('inspire');
  });

  it('builds a song around a hook or a few short lines', () => {
    expect(seedMode('Kemi, Kemi, dance tonight\nThe jollof is ready, the lights are bright', 'auto')).toBe('complete');
  });

  it('respects an explicit choice', () => {
    expect(seedMode('one line', 'exact')).toBe('exact');
    expect(seedMode('one line', 'inspire')).toBe('inspire');
  });
});
