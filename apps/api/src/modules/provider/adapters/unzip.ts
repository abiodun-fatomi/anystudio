/**
 * Read a small ZIP held in memory — the stems a vendor returns come as one.
 * Stored and deflated entries only, no encryption, no ZIP64: exactly what
 * an API hands back, and nothing a dependency is needed for.
 */
import { inflateRawSync } from 'node:zlib';

export interface ZipEntry {
  name: string;
  bytes: Uint8Array;
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

export function unzip(buf: Uint8Array): ZipEntry[] {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // The end-of-central-directory record is within the last 64 KiB (comment length is 16 bits).
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65_558); i--) {
    if (view.getUint32(i, true) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const out: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (view.getUint32(offset, true) !== CENTRAL) throw new Error('zip central directory is damaged');
    const method = view.getUint16(offset + 10, true);
    const compressed = view.getUint32(offset + 20, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const local = view.getUint32(offset + 42, true);
    const name = Buffer.from(buf.subarray(offset + 46, offset + 46 + nameLen)).toString('utf8');
    if (view.getUint32(local, true) !== LOCAL) throw new Error(`zip entry "${name}" is damaged`);
    const dataStart = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = buf.subarray(dataStart, dataStart + compressed);
    if (!name.endsWith('/')) {
      if (method === 0) out.push({ name, bytes: data });
      else if (method === 8) out.push({ name, bytes: new Uint8Array(inflateRawSync(data)) });
      else throw new Error(`zip entry "${name}" uses compression ${method}, which is not supported`);
    }
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
