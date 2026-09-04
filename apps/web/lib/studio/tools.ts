/**
 * The studio's tools: what the tool strip shows, which capability each one
 * asks the API for, and the controls its panel renders.
 *
 * Each field maps straight onto a key of the capability's params schema in
 * packages/shared, which is the validator of record. This file decides how
 * a param is presented — a segmented control, a slider, a text box — not
 * whether it is valid. Adding a tool is adding an entry here.
 */
import { ASPECTS, EXPORT_SIZES, type Capability, type ExportSize } from '@anystudio/shared';
import type { IconName } from '@/components/shell/icons';

export type ToolId = 'scene' | 'background' | 'cutout' | 'enhance' | 'copy' | 'video' | 'flyer' | 'restyle';

export type Field =
  | { key: string; kind: 'text'; label: string; placeholder?: string; hint?: string; maxLength?: number; rows?: number; required?: boolean }
  | { key: string; kind: 'segment'; label: string; options: Array<{ id: string; label: string }> }
  | { key: string; kind: 'select'; label: string; options: Array<{ value: string; label: string }> }
  | { key: string; kind: 'switch'; label: string; hint?: string }
  | { key: string; kind: 'sizes'; label: string }
  | { key: string; kind: 'platforms'; label: string }
  | { key: string; kind: 'slider'; label: string; min: number; max: number; step: number; format: (v: number) => string };

export interface Tool {
  id: ToolId;
  label: string;
  short: string;
  icon: IconName;
  capability: Capability;
  /** Needs a source photo on the canvas. Copy can work from a photo or from text alone. */
  needsSource: boolean;
  /** What to tell someone while they wait. The worker's own stage detail overrides this when present. */
  narrative: Record<string, string>;
  fields: Field[];
  defaults: Record<string, unknown>;
}

const SIZE_OPTIONS = Object.entries(EXPORT_SIZES).map(([id, s]) => ({ id: id as ExportSize, label: `${s.aspect} · ${s.width}×${s.height}`, short: id.replace('_', ' ') }));
export { SIZE_OPTIONS };

const IMAGE_STAGES = { queued: 'Waiting for a slot', preparing: 'Reading your photo', routing: 'Choosing the best model', generating: 'Placing your product in the scene', composing: 'Adding your name and price, cutting every size', storing: 'Saving your images', done: 'Done' };

export const TOOLS: Tool[] = [
  {
    id: 'scene', label: 'New scene', short: 'Scene', icon: 'studio', capability: 'IMAGE_EDIT', needsSource: true,
    narrative: IMAGE_STAGES,
    fields: [
      { key: 'prompt', kind: 'text', label: 'Where should the product be?', placeholder: 'On a marble kitchen counter in soft morning light', rows: 3, maxLength: 600, required: true, hint: 'Describe the surroundings. The product itself stays exactly as photographed.' },
      { key: 'aspect', kind: 'segment', label: 'Shape', options: ASPECTS.map((a) => ({ id: a, label: a })) },
      { key: 'sizes', kind: 'sizes', label: 'Export sizes' },
      { key: 'price', kind: 'text', label: 'Price on the image', placeholder: '₦12,000', maxLength: 40 },
      { key: 'businessName', kind: 'text', label: 'Business name on the image', placeholder: 'Leave blank to use your brand kit', maxLength: 80 },
    ],
    defaults: { preserveProduct: true, aspect: '1:1', sizes: ['feed_square', 'story'] },
  },
  {
    id: 'background', label: 'Replace background', short: 'Background', icon: 'brand', capability: 'BACKGROUND_REPLACE', needsSource: true,
    narrative: { ...IMAGE_STAGES, generating: 'Building the new background' },
    fields: [
      { key: 'prompt', kind: 'text', label: 'New background', placeholder: 'Plain warm beige studio backdrop', rows: 2, maxLength: 400, required: true },
      { key: 'aspect', kind: 'segment', label: 'Shape', options: ASPECTS.map((a) => ({ id: a, label: a })) },
      { key: 'shadow', kind: 'switch', label: 'Natural shadow', hint: 'A soft contact shadow so it sits on the surface' },
      { key: 'relight', kind: 'switch', label: 'Match the lighting' },
    ],
    defaults: { aspect: '1:1', shadow: true, relight: true },
  },
  {
    id: 'cutout', label: 'Remove background', short: 'Cut out', icon: 'swap', capability: 'BACKGROUND_REMOVE', needsSource: true,
    narrative: { ...IMAGE_STAGES, generating: 'Cutting out the product' },
    fields: [
      { key: 'background', kind: 'segment', label: 'Behind it', options: [{ id: 'transparent', label: 'Transparent' }, { id: '#FFFFFF', label: 'White' }, { id: '#F3F3F3', label: 'Light grey' }, { id: '#17131A', label: 'Black' }] },
    ],
    defaults: { background: 'transparent' },
  },
  {
    id: 'enhance', label: 'Enhance', short: 'Enhance', icon: 'insights', capability: 'UPSCALE', needsSource: true,
    narrative: { ...IMAGE_STAGES, generating: 'Sharpening and enlarging' },
    fields: [
      { key: 'factor', kind: 'segment', label: 'Enlarge', options: [{ id: '2', label: '2×' }, { id: '4', label: '4×' }] },
    ],
    defaults: { factor: 2 },
  },
  {
    id: 'restyle', label: 'Restyle', short: 'Restyle', icon: 'swap', capability: 'IMAGE_EDIT', needsSource: true,
    narrative: { ...IMAGE_STAGES, generating: 'Restyling your photo', composing: 'Cutting every size' },
    fields: [
      { key: 'prompt', kind: 'text', label: 'How should it look?', placeholder: 'Warm film look, golden hour, soft grain', rows: 3, maxLength: 600, required: true, hint: 'For a personal photo or a flyer you already have. The whole image can change.' },
      { key: 'aspect', kind: 'segment', label: 'Shape', options: ASPECTS.map((a) => ({ id: a, label: a })) },
      { key: 'sizes', kind: 'sizes', label: 'Export sizes' },
    ],
    defaults: { preserveProduct: false, aspect: '1:1', sizes: ['feed_square', 'story'], brand: { showPrice: false, showBusinessName: false } },
  },
  {
    id: 'flyer', label: 'Make a flyer', short: 'Flyer', icon: 'today', capability: 'IMAGE_GENERATE', needsSource: false,
    narrative: { queued: 'Waiting for a slot', preparing: 'Reading your brief', routing: 'Choosing a model', generating: 'Designing your flyer', composing: 'Finishing', storing: 'Saving', done: 'Done' },
    fields: [
      { key: 'prompt', kind: 'text', label: 'What is it for?', placeholder: 'Birthday brunch for Tolu, Saturday 12 October, 1pm, Lekki. Bold, joyful, gold and green.', rows: 4, maxLength: 1200, required: true, hint: 'Say the occasion, the date, the place and the feeling. Words on the flyer come out best when you write them exactly.' },
      { key: 'style', kind: 'select', label: 'Style', options: [{ value: 'bold poster, big type, flat colour', label: 'Bold poster' }, { value: 'elegant, minimal, lots of space', label: 'Elegant' }, { value: 'playful, illustrated, bright', label: 'Playful' }, { value: 'photographic, premium, cinematic', label: 'Premium photo' }, { value: 'traditional Nigerian motifs, ankara patterns, warm', label: 'Traditional' }] },
      { key: 'aspect', kind: 'segment', label: 'Shape', options: [{ id: '9:16', label: 'Status 9:16' }, { id: '4:5', label: 'Feed 4:5' }, { id: '1:1', label: 'Square' }] },
    ],
    defaults: { aspect: '9:16', count: 1, style: 'bold poster, big type, flat colour' },
  },
  {
    id: 'copy', label: 'Write the listing', short: 'Copy', icon: 'library', capability: 'TEXT_GENERATE', needsSource: false,
    narrative: { queued: 'Waiting for a slot', preparing: 'Looking at your photo', routing: 'Choosing a writer', generating: 'Writing your listing and captions', composing: 'Checking every platform limit', storing: 'Saving', done: 'Done' },
    fields: [
      { key: 'productName', kind: 'text', label: 'Product name', placeholder: 'Ankara tote bag', maxLength: 120 },
      { key: 'details', kind: 'text', label: 'Anything the photo does not show', placeholder: 'Handmade in Lagos, fits a 14" laptop, three colours', rows: 3, maxLength: 800 },
      { key: 'price', kind: 'text', label: 'Price', placeholder: '₦12,000', maxLength: 40 },
      { key: 'language', kind: 'select', label: 'Language', options: [{ value: 'en', label: 'English' }, { value: 'en-NG', label: 'Nigerian English' }, { value: 'pcm', label: 'Pidgin' }, { value: 'yo', label: 'Yoruba' }, { value: 'ig', label: 'Igbo' }, { value: 'ha', label: 'Hausa' }, { value: 'fr', label: 'French' }, { value: 'sw', label: 'Swahili' }] },
      { key: 'platforms', kind: 'platforms', label: 'Captions for' },
    ],
    defaults: { task: 'product_copy', language: 'en', platforms: ['instagram', 'whatsapp_status'] },
  },
  {
    id: 'video', label: 'Make a reel', short: 'Video', icon: 'publish', capability: 'IMAGE_TO_VIDEO', needsSource: true,
    narrative: { queued: 'Waiting for a video slot', preparing: 'Reading your photo', routing: 'Choosing a video model', generating: 'Rendering your reel — this takes a few minutes', composing: 'Finishing', storing: 'Saving your video', done: 'Done' },
    fields: [
      { key: 'prompt', kind: 'text', label: 'What happens', placeholder: 'The camera slowly pushes in as light sweeps across the fabric', rows: 3, maxLength: 600, required: true },
      { key: 'motion', kind: 'text', label: 'Camera', placeholder: 'slow push-in · orbit · tilt up · rack focus', maxLength: 200 },
      { key: 'durationSec', kind: 'segment', label: 'Length', options: [{ id: '5', label: '5 s' }, { id: '8', label: '8 s' }] },
      { key: 'aspect', kind: 'segment', label: 'Shape', options: [{ id: '9:16', label: '9:16' }, { id: '1:1', label: '1:1' }, { id: '16:9', label: '16:9' }] },
    ],
    defaults: { durationSec: 5, aspect: '9:16', audio: false },
  },
];

export const toolById = (id: string | null | undefined): Tool => TOOLS.find((t) => t.id === id) ?? TOOLS[0]!;

/** Segments and selects carry strings; some params are numbers. Coerce by the tool's defaults. */
export function coerceParams(tool: Tool, values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...tool.defaults, ...values };
  for (const [k, d] of Object.entries(tool.defaults)) {
    if (typeof d === 'number' && typeof out[k] === 'string') out[k] = Number(out[k]);
  }
  for (const [k, v] of Object.entries(out)) if (v === '' || v === undefined) delete out[k];
  return out;
}

export const PLATFORM_OPTIONS = [
  { id: 'instagram', label: 'Instagram' }, { id: 'whatsapp_status', label: 'WhatsApp Status' }, { id: 'tiktok', label: 'TikTok' }, { id: 'facebook', label: 'Facebook' }, { id: 'x', label: 'X' },
];
