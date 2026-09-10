/**
 * Content type from the first bytes. Twenty lines instead of a dependency,
 * covering exactly the formats the product accepts.
 */

export function sniffMime(b: Uint8Array): string | null {
  const at = (i: number) => b[i] ?? -1;
  const ascii = (from: number, len: number) => String.fromCharCode(...b.slice(from, from + len));

  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg';
  if (at(0) === 0x89 && ascii(1, 3) === 'PNG') return 'image/png';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'image/webp';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') return 'audio/wav';
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return 'image/gif';
  if (ascii(0, 4) === 'OggS') return 'audio/ogg';
  if (ascii(0, 3) === 'ID3' || (at(0) === 0xff && (at(1) & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (at(0) === 0x1a && at(1) === 0x45 && at(2) === 0xdf && at(3) === 0xa3) return 'video/webm';

  // ISO base media: bytes 4–7 are "ftyp", the brand follows.
  if (ascii(4, 4) === 'ftyp') {
    const brand = ascii(8, 4);
    if (brand.startsWith('heic') || brand.startsWith('heix') || brand.startsWith('mif1')) return 'image/heic';
    if (brand === 'qt  ') return 'video/quicktime';
    if (brand === 'M4A ') return 'audio/mp4';
    return 'video/mp4';
  }
  return null;
}
