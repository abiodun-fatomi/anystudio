/**
 * A morning's shooting, in one gesture.
 *
 * The picker could already take several files at once, which is fine for six
 * and useless for sixty: nobody ctrl-clicks their way through a catalogue.
 * This is the other half — drag the folder in, or choose it, and everything
 * photographable inside comes with it.
 *
 * Three things this has to get right, because a merchant on a Lagos
 * connection will find all three:
 *
 *   ORDER. A folder read by the browser arrives in whatever order the
 *   filesystem felt like. Photos are named for a reason (IMG_0041, dress-2),
 *   so they are sorted the way a person would sort them — numbers as numbers,
 *   not as text, so IMG_9 comes before IMG_10.
 *
 *   PATIENCE. Sixty uploads fired at once is sixty connections competing for
 *   one phone tether, and the browser stalls. A small pool keeps a few in
 *   flight and the rest waiting their turn.
 *
 *   FORGIVENESS. One unreadable file must not lose the other fifty-nine. Each
 *   upload reports its own outcome and the caller keeps what worked.
 */

import { uploadFile } from '@/lib/upload';
import type { MediaAssetRow } from '@/lib/api';

/** What a phone or a camera puts in a folder, and what our tools can read. */
const PHOTO = /\.(jpe?g|png|webp|heic|heif|avif)$/i;
export const isPhoto = (f: File): boolean => f.type.startsWith('image/') || PHOTO.test(f.name);

/** How many uploads are in the air at once. Enough to be quick, few enough not to stall a tether. */
const IN_FLIGHT = 3;

/**
 * The files inside a dropped folder, however deep.
 *
 * Dropping a directory hands over an entry rather than a file, and the only
 * way through it is the non-standard `webkitGetAsEntry` tree — which every
 * browser we target implements and none of them types. Depth is capped so a
 * symlinked loop or someone's entire Pictures library cannot hang the tab.
 */
export async function filesFromDrop(items: DataTransferItemList, maxDepth = 4): Promise<File[]> {
  type Entry = {
    isFile: boolean;
    isDirectory: boolean;
    file: (cb: (f: File) => void, err: (e: unknown) => void) => void;
    createReader: () => { readEntries: (cb: (e: Entry[]) => void, err: (e: unknown) => void) => void };
  };
  const roots: Entry[] = [];
  for (const item of Array.from(items)) {
    const entry = (item as unknown as { webkitGetAsEntry?: () => Entry | null }).webkitGetAsEntry?.();
    if (entry) roots.push(entry);
  }
  // No entry API — an ordinary multi-file drop, which is still perfectly good.
  if (roots.length === 0) return [];

  const out: File[] = [];
  const walk = async (entry: Entry, depth: number): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File | null>((resolve) => entry.file(resolve, () => resolve(null)));
      if (file && isPhoto(file)) out.push(file);
      return;
    }
    if (!entry.isDirectory || depth >= maxDepth) return;
    const reader = entry.createReader();
    // readEntries hands back a page at a time and an empty page means done.
    for (;;) {
      const batch = await new Promise<Entry[]>((resolve) => reader.readEntries(resolve, () => resolve([])));
      if (batch.length === 0) break;
      for (const child of batch) await walk(child, depth + 1);
    }
  };
  for (const root of roots) await walk(root, 0);
  return out;
}

/**
 * The order a person would put them in.
 *
 * Digits compare as numbers, so IMG_9 sorts before IMG_10 rather than after
 * it. A catalogue shot in sequence then stays in sequence, which matters
 * because the first photo of a batch is the one whose result gets looked at.
 */
export const inHumanOrder = (files: File[]): File[] =>
  [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

export interface FolderUpload {
  /** Assets that made it, in the order they were given. */
  added: MediaAssetRow[];
  /** Names that did not, with the reason — shown, never swallowed. */
  failed: Array<{ name: string; reason: string }>;
  /** Photos left out because the batch was already full. */
  skipped: number;
}

/**
 * Upload many, a few at a time, reporting as it goes.
 *
 * `room` is how many more the caller can accept; anything past it is counted
 * and left alone rather than uploaded and then refused, which would spend
 * someone's data on a photo they cannot use.
 */
export async function uploadMany(
  workspaceId: string,
  files: File[],
  room: number,
  onProgress?: (done: number, total: number, name: string) => void,
): Promise<FolderUpload> {
  const photos = inHumanOrder(files.filter(isPhoto));
  const take = photos.slice(0, Math.max(0, room));
  const result: FolderUpload = { added: [], failed: [], skipped: photos.length - take.length };
  if (take.length === 0) return result;

  // Slots keep their place, so the finished list is in the order dropped even
  // though the uploads finish in whatever order the network allows.
  const slots: Array<MediaAssetRow | null> = Array(take.length).fill(null);
  let next = 0;
  let done = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      const file = take[i];
      if (!file) return;
      try {
        slots[i] = await uploadFile(workspaceId, file);
      } catch (err) {
        result.failed.push({ name: file.name, reason: err instanceof Error ? err.message : 'Upload failed' });
      }
      onProgress?.(++done, take.length, file.name);
    }
  };
  await Promise.all(Array.from({ length: Math.min(IN_FLIGHT, take.length) }, worker));

  result.added = slots.filter((s): s is MediaAssetRow => s !== null);
  return result;
}
