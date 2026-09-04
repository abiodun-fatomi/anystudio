import { describe, expect, it } from 'vitest';
import { sniffMime } from './sniff';

const bytes = (...b: Array<number | string>) => new Uint8Array(b.flatMap((x) => (typeof x === 'string' ? [...x].map((c) => c.charCodeAt(0)) : [x])));

describe('sniffMime', () => {
  it('reads the real type from the first bytes, whatever the file name said', () => {
    expect(sniffMime(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg');
    expect(sniffMime(bytes(0x89, 'PNG', 0x0d, 0x0a))).toBe('image/png');
    expect(sniffMime(bytes('RIFF', 0, 0, 0, 0, 'WEBP'))).toBe('image/webp');
    expect(sniffMime(bytes(0, 0, 0, 0x18, 'ftyp', 'isom'))).toBe('video/mp4');
    expect(sniffMime(bytes(0, 0, 0, 0x18, 'ftyp', 'heic'))).toBe('image/heic');
    expect(sniffMime(bytes('ID3', 3, 0))).toBe('audio/mpeg');
  });
  it('refuses what it does not know', () => {
    expect(sniffMime(bytes('<html>'))).toBeNull();
    expect(sniffMime(bytes('MZ', 0x90, 0))).toBeNull();
    expect(sniffMime(new Uint8Array(0))).toBeNull();
  });
});
