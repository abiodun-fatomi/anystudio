import { describe, expect, it } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { unzip } from './unzip';

/** A minimal ZIP writer for the test: stored or deflated entries, no extras. */
function zip(entries: Array<{ name: string; data: Buffer; deflate?: boolean }>): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const body = e.deflate ? deflateRawSync(e.data) : e.data;
    const method = e.deflate ? 8 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const rec = Buffer.concat([local, name, body]);
    locals.push(rec);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, name]));
    offset += rec.length;
  }
  const dir = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(dir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, dir, eocd]));
}

describe('unzip', () => {
  it('reads stored and deflated entries and skips directories', () => {
    const vocals = Buffer.from('VOCALS'.repeat(100));
    const inst = Buffer.from('INSTRUMENTAL'.repeat(100));
    const out = unzip(
      zip([
        { name: 'stems/', data: Buffer.alloc(0) },
        { name: 'stems/vocals.mp3', data: vocals, deflate: true },
        { name: 'stems/instrumental.mp3', data: inst },
      ]),
    );
    expect(out.map((e) => e.name)).toEqual(['stems/vocals.mp3', 'stems/instrumental.mp3']);
    expect(Buffer.from(out[0]!.bytes).equals(vocals)).toBe(true);
    expect(Buffer.from(out[1]!.bytes).equals(inst)).toBe(true);
  });

  it('refuses something that is not a zip', () => {
    expect(() => unzip(new Uint8Array(Buffer.from('ID3 definitely an mp3 and not an archive at all')))).toThrow(/not a zip/);
  });
});
