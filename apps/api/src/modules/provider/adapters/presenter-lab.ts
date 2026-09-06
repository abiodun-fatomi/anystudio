/**
 * What a vendor must do to put a person on camera: turn a face (a stock
 * avatar, or one photo) and a piece of audio into a video of that person
 * saying it. Like VoiceLab, a side door on the adapter rather than a
 * routed capability — the presenter catalogue names the vendor.
 */
import type { GenerationProvider } from '@anystudio/shared';

export interface TalkingVideoInput {
  /** One of the two. */
  avatarId?: string;
  photo?: { bytes: Uint8Array; mime: string };
  /** A public (signed) URL of the speech; the video is exactly as long as this. */
  audioUrl: string;
  aspect: '9:16' | '1:1' | '16:9';
  title: string;
}

export interface PresenterLab extends GenerationProvider {
  talkingVideo(
    input: TalkingVideoInput,
    opts: { timeoutMs: number; signal?: AbortSignal; onProgress?: (detail: string, progress?: number) => void },
  ): Promise<{ url: string; providerJobId: string }>;
  /** Vendor cost of a talking segment of this many seconds, minor units. */
  presenterCostMinor(seconds: number): number;
}

export function isPresenterLab(p: GenerationProvider | undefined): p is PresenterLab {
  return Boolean(p) && typeof (p as PresenterLab).talkingVideo === 'function';
}
