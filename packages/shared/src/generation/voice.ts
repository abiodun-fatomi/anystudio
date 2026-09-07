/**
 * Whose studio it is.
 *
 * A merchant watching their video render saw "fal is generating". They have
 * never heard of fal, they did not choose fal, and next month it may not be
 * fal — the whole point of the provider plane is that an operator can change
 * the vendor during an outage without a deploy. Naming one in the progress
 * line tells the customer something untrue (that this is fal's product) and
 * something they cannot use (which company had the GPU).
 *
 * It is also a promise we cannot keep. Route a capability to a different
 * vendor and every one of those sentences becomes a lie, silently.
 *
 * So the rule is one line: WHAT IS HAPPENING, NOT WHO IS DOING IT.
 * "Rendering your video", never "Veo is rendering".
 *
 * Two layers enforce it. The adapters are written in the product's voice, and
 * `inOurVoice` is a chokepoint on the way to the customer that catches the
 * ones that are not — a new adapter, a vendor's own status string echoed
 * back, a message nobody reviewed.
 */

/**
 * Every name a customer must not be shown: vendors, their models, and the
 * infrastructure words that mean nothing outside this repository.
 *
 * Kept deliberately broad. A false positive costs one generic progress line;
 * a miss puts a supplier's name in front of a merchant.
 */
export const VENDOR_WORDS: readonly string[] = [
  // houses
  'fal',
  'elevenlabs',
  'eleven labs',
  'heygen',
  'higgsfield',
  'photoroom',
  'replicate',
  'openai',
  'anthropic',
  'google',
  'vertex',
  'bfl',
  'runway',
  'sync.so',
  'bria',
  'cloudflare',
  // models
  'veo',
  'sora',
  'flux',
  'gemini',
  'claude',
  'kling',
  'seedream',
  'minimax',
  'wan',
  'birefnet',
  'clarity',
  'dall-e',
  'imagen',
  // ours, but not theirs to read
  'stub',
  'ffmpeg',
  'sharp',
  'provider',
  'adapter',
];

/**
 * A word boundary that also holds for names with punctuation ("sync.so",
 * "dall-e") and refuses to match inside an ordinary word — "falling" is not
 * "fal", and "syncing" is not "sync".
 */
const NAMES = new RegExp(`(^|[^a-z0-9])(${VENDOR_WORDS.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![a-z0-9])`, 'i');

/** Whether a line would show a customer who is behind the curtain. */
export const namesAVendor = (text: string | null | undefined): boolean => Boolean(text && NAMES.test(text));

/**
 * The customer-facing version of a progress line.
 *
 * A line that names a vendor is replaced wholesale rather than edited: taking
 * the word out of "fal is generating" leaves "is generating", which reads
 * like a bug. The fallback is chosen by what stage the work is at, so the
 * replacement still says something true.
 */
export function inOurVoice(detail: string | null | undefined, fallback = 'Working on it'): string | undefined {
  if (!detail) return undefined;
  return namesAVendor(detail) ? fallback : detail;
}

/** What to say instead, per stage, when a line has to be replaced. */
export const STAGE_FALLBACK: Record<string, string> = {
  queued: 'Waiting for a slot',
  preparing: 'Getting your files ready',
  routing: 'Choosing the best studio for this',
  generating: 'Making it',
  composing: 'Putting it together',
  waiting: 'Working through the shots',
  storing: 'Saving your work',
};
