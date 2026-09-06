import { describe, expect, it } from 'vitest';
import { baseMime } from './media.service';

describe('what a browser announces', () => {
  it('drops the codec parameters a recorder adds', () => {
    expect(baseMime('audio/webm;codecs=opus')).toBe('audio/webm');
    expect(baseMime('audio/mp4; codecs="mp4a.40.2"')).toBe('audio/mp4');
    expect(baseMime('video/webm;codecs=vp9,opus')).toBe('video/webm');
  });

  it('leaves a plain type alone, and lowercases a shouted one', () => {
    expect(baseMime('image/jpeg')).toBe('image/jpeg');
    expect(baseMime('IMAGE/PNG')).toBe('image/png');
    expect(baseMime(' audio/mpeg ')).toBe('audio/mpeg');
  });
});
