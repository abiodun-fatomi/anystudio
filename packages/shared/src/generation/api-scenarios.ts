import type { Capability } from './capabilities';
import { PRODUCT_MODES } from './product-shots';

export interface ApiScenario {
  id: string;
  title: string;
  note: string;
  body: { capability: Exclude<Capability, 'VIDEO_STITCH'>; params: Record<string, unknown>; clientKey: string; merchantRef: string };
}

const photo = 'YOUR_WORKSPACE/uploads/product.jpg';
const second = 'YOUR_WORKSPACE/uploads/product-back.jpg';
const video = 'YOUR_WORKSPACE/uploads/speaker.mp4';
const audio = 'YOUR_WORKSPACE/uploads/speech.mp3';
const scenario = (id: string, title: string, capability: ApiScenario['body']['capability'], params: Record<string, unknown>, note = ''): ApiScenario => ({
  id,
  title,
  note,
  body: { capability, params, clientKey: `catalogue:store-441:sku-9:${id}:v1`, merchantRef: 'store-441' },
});

/** Used by the organization docs and API discovery; every example is schema-tested. */
export const API_SCENARIOS: ApiScenario[] = [
  scenario(
    'product-scene',
    'Branded product image',
    'IMAGE_EDIT',
    { sourceKey: photo, prompt: 'On a marble counter in soft morning light', preserveProduct: true, sizes: ['feed_square', 'story'] },
    'Review product fidelity before publishing; AI edits are not a pixel-identity guarantee.',
  ),
  scenario(
    'new-image',
    'Image from text',
    'IMAGE_GENERATE',
    { prompt: 'A minimal botanical poster with soft green shapes', aspect: '4:5', count: 1 },
    'This scenario has no source photo. Use IMAGE_EDIT to preserve an existing product.',
  ),
  scenario('cutout', 'Transparent product cutout', 'BACKGROUND_REMOVE', { sourceKey: photo, background: 'transparent' }),
  scenario('background', 'Replace the background', 'BACKGROUND_REPLACE', {
    sourceKey: photo,
    prompt: 'A plain warm grey studio background',
    shadow: true,
    relight: true,
  }),
  scenario('lighting', 'Adjust lighting', 'RELIGHT', { sourceKey: photo, prompt: 'Soft daylight from the left' }),
  scenario('upscale', 'Enlarge an image', 'UPSCALE', { sourceKey: photo, factor: 2 }),
  scenario(
    'collage',
    'Combine product angles',
    'COLLAGE',
    { sourceKeys: [photo, second], layout: 'row', fit: 'fit', labels: ['Front', 'Back'], sizes: ['feed_square', 'story'] },
    'Order matters. Upload every source first; a collage is one output, not a batch.',
  ),
  ...Object.entries(PRODUCT_MODES).map(([mode, item]) =>
    scenario(
      `product-${mode}`,
      item.label,
      'PRODUCT_SHOT',
      {
        sourceKey: photo,
        mode,
        ...(mode === 'edit' ? { prompt: 'Remove the hanger while keeping the garment unchanged' } : {}),
        ...(mode === 'on_model' ? { shotSize: 'posting' } : {}),
      },
      mode === 'text_removal'
        ? 'Only remove text from media you have the rights and permission to edit.'
        : 'Availability depends on the configured product-photo provider. Quote the selected mode before submitting.',
    ),
  ),
  scenario(
    'batch',
    'Apply one operation to a catalogue',
    'BATCH',
    { of: 'BACKGROUND_REMOVE', sourceKeys: [photo, second], params: { background: '#FFFFFF' } },
    '2–100 photos. Price is per photo. A successful parent may contain only the successful outputs; failed items receive proportional refunds.',
  ),
  scenario('copy', 'Product description and social captions', 'TEXT_GENERATE', {
    productName: 'Ankara tote',
    productKey: 'sku-9',
    details: 'Cotton lining, zipped inside pocket',
    language: 'en',
    platforms: ['instagram', 'whatsapp_status'],
  }),
  scenario(
    'reel',
    'Single-shot product reel',
    'IMAGE_TO_VIDEO',
    { sourceKey: photo, shots: 1, format: 'reveal', durationSec: 8, aspect: '9:16', audio: false },
    'Duration requests are normalized by the chosen provider; inspect the returned duration.',
  ),
  scenario(
    'ad-15',
    '15-second multi-shot ad',
    'IMAGE_TO_VIDEO',
    { sourceKey: photo, shots: 2, format: 'benefits', productName: 'Ankara tote', details: 'Cotton lining and zipped pocket', aspect: '9:16' },
    'Poll the parent ID. Child generation and final stitching are automatic; do not call VIDEO_STITCH.',
  ),
  scenario(
    'ad-30',
    '30-second multi-shot ad',
    'IMAGE_TO_VIDEO',
    { sourceKey: photo, shots: 4, format: 'unboxing', productName: 'Ankara tote', aspect: '9:16' },
    'Use shots: 6 for a 45-second ad or shots: 8 for a 60-second ad. Quote each configuration.',
  ),
  scenario(
    'presenter',
    'Consenting presenter in a UGC-style ad',
    'IMAGE_TO_VIDEO',
    {
      sourceKey: photo,
      shots: 2,
      format: 'ugc',
      presenter: { kind: 'photo', photoKey: 'YOUR_WORKSPACE/uploads/presenter.jpg', consent: true, script: 'Here is a closer look at the new tote.' },
    },
    'Requires a configured presenter provider and permission from the person. Upload their photo first. Do not invent customer testimonials.',
  ),
  scenario(
    'voiceover',
    'Read a script',
    'VOICEOVER',
    { script: 'Explore our new collection today.', voiceId: 'VOICE_KEY', style: 'natural', speed: 1 },
    'Replace VOICE_KEY with a key from GET /catalogue/audio/voices.',
  ),
  scenario(
    'song',
    'Song preview, then paid unlock',
    'MUSIC',
    { brief: 'A cheerful song celebrating a new handmade bag collection', genre: 'GENRE_KEY', vocal: 'female', durationSec: 60 },
    'Replace GENRE_KEY from GET /catalogue/audio/genres. Preview generation and full-track unlock are separate charges.',
  ),
  scenario(
    'instrumental',
    'Instrumental music',
    'MUSIC',
    { brief: 'An upbeat instrumental for a product showcase', genre: 'GENRE_KEY', vocal: 'instrumental', durationSec: 30 },
    'The full track is still locked until POST /generations/{id}/unlock succeeds.',
  ),
  scenario(
    'dub',
    'Translate speech, preserve the picture',
    'DUB',
    { sourceKey: video, targetLanguage: 'fr', lipsync: false, consent: true },
    'Use a served language code from GET /catalogue/audio/dub-languages. The server measures source duration; maximum 300 seconds without lip sync.',
  ),
  scenario(
    'dub-lips',
    'Translate speech and match the lips',
    'DUB',
    { sourceKey: video, targetLanguage: 'fr', lipsync: true, quality: 'speed', consent: true },
    'Maximum 180 seconds with lip sync. Costs more than voice-only dubbing; precision quality costs more again.',
  ),
  scenario(
    'lips-audio',
    'Lip-sync uploaded speech',
    'LIPSYNC',
    { sourceKey: video, audioKey: audio, consent: true },
    'Upload video and audio separately. Maximum source video duration is 180 seconds.',
  ),
  scenario(
    'lips-script',
    'Lip-sync a new script',
    'LIPSYNC',
    { sourceKey: video, script: 'Our new collection is available now.', voiceId: 'VOICE_KEY', consent: true },
    'Choose a served voice key. Send either audioKey or script; omit audioKey when you want the script recorded.',
  ),
];
