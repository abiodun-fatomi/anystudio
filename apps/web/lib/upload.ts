/**
 * Upload a file: announce it, PUT the bytes straight to storage, tell the
 * API it landed. XHR rather than fetch for the one thing fetch cannot do —
 * report upload progress — which on a phone on 3G is the difference between
 * "it's working" and "it's broken".
 */
import { api, ApiError, type MediaAssetRow } from './api';

export interface UploadProgress {
  loaded: number;
  total: number;
  pct: number;
}

export async function uploadFile(workspaceId: string, file: File, onProgress?: (p: UploadProgress) => void, signal?: AbortSignal): Promise<MediaAssetRow> {
  const mime = file.type || guessMime(file.name);
  const presigned = await api.media.presign(workspaceId, { filename: file.name, mime, bytes: file.size });

  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(presigned.method, presigned.url, true);
    for (const [k, v] of Object.entries(presigned.headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.({ loaded: e.loaded, total: e.total, pct: Math.round((e.loaded / e.total) * 100) });
    };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Storage refused the upload (${xhr.status}).`)));
    xhr.onerror = () => reject(new Error('The upload was interrupted. Check your connection and try again.'));
    xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(file);
  });

  try {
    return await api.media.complete(workspaceId, presigned.assetId);
  } catch (err) {
    if (err instanceof ApiError && err.fields?.length) throw new Error(err.fields.map((f) => f.message).join(' '));
    if (err instanceof ApiError) throw new Error(err.message);
    throw err;
  }
}

function guessMime(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return (
    (
      {
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        png: 'image/png',
        webp: 'image/webp',
        heic: 'image/heic',
        gif: 'image/gif',
        mp4: 'video/mp4',
        mov: 'video/quicktime',
        mp3: 'audio/mpeg',
        m4a: 'audio/mp4',
        wav: 'audio/wav',
      } as Record<string, string>
    )[ext] ?? 'application/octet-stream'
  );
}
