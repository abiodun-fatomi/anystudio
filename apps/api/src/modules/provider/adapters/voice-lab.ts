/**
 * What a vendor must do for "your own voice" beyond generating: keep a
 * cloned voice, split a song into its stems, and convert a vocal into a
 * voice it holds. These are not capabilities the router prices and routes
 * — the clone lives with ONE vendor, and every later step has to happen
 * where the clone is — so they are a side door on the adapter, found by
 * the VoiceProfile's providerKey and this type guard.
 */
import type { GenerationProvider } from '@anystudio/shared';

export interface VoiceSample {
  bytes: Uint8Array;
  mime: string;
  filename: string;
}

export interface VoiceLab extends GenerationProvider {
  /** Make a voice from a few seconds to a few minutes of one person talking. */
  cloneVoice(
    input: { name: string; samples: VoiceSample[]; description?: string; labels?: Record<string, string> },
    signal?: AbortSignal,
  ): Promise<{ providerVoiceId: string }>;
  /** Forget the voice at the vendor. Idempotent: a voice already gone is not an error. */
  deleteVoice(providerVoiceId: string, signal?: AbortSignal): Promise<void>;
  /** A song → its vocal and everything else, sample-aligned with the original. */
  separateStems(audio: VoiceSample, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<{ vocals: Uint8Array; instrumental: Uint8Array; mime: string }>;
  /** Speech or singing → the same performance in the given voice. */
  convertVoice(
    providerVoiceId: string,
    audio: VoiceSample,
    opts: { timeoutMs: number; signal?: AbortSignal; language?: string },
  ): Promise<{ bytes: Uint8Array; mime: string }>;
  /** Vendor cost of one clone + a stems split + a conversion, in minor units, for the ledger. */
  voiceLabCostMinor(step: 'clone' | 'stems' | 'convert', seconds: number): number;
}

export function isVoiceLab(p: GenerationProvider | undefined): p is VoiceLab {
  return Boolean(p) && typeof (p as VoiceLab).cloneVoice === 'function' && typeof (p as VoiceLab).convertVoice === 'function';
}
