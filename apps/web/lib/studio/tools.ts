/**
 * The studio's tools: what the tool strip shows, which capability each one
 * asks the API for, and the controls its panel renders.
 *
 * Each field maps straight onto a key of the capability's params schema in
 * packages/shared, which is the validator of record. This file decides how
 * a param is presented — a segmented control, a slider, a text box — not
 * whether it is valid. Adding a tool is adding an entry here.
 */
import {
  ASPECTS,
  COLLAGE_LAYOUTS,
  COLLAGE_MAX_PHOTOS,
  COLLAGE_MIN_PHOTOS,
  EXPORT_SIZES,
  PIPELINE_WRITTEN_KEYS,
  type Capability,
  type CollageLayout,
  type ExportSize,
  adPlan,
  collageLayoutsFor,
  presenterCostCode,
} from '@anystudio/shared';
import type { IconName } from '@/components/shell/icons';

export type ToolId =
  'scene' | 'background' | 'cutout' | 'enhance' | 'copy' | 'video' | 'flyer' | 'collage' | 'restyle' | 'music' | 'voice' | 'translate' | 'lipsync';

export type Field =
  | {
      key: string;
      kind: 'text';
      label: string;
      placeholder?: string;
      hint?: string;
      maxLength?: number;
      rows?: number;
      required?: boolean;
      /** Words offered as tap-to-fill chips under the box; typing stays possible. A tap toggles the word in a comma-separated list. */
      suggestions?: string[];
    }
  | { key: string; kind: 'segment'; label: string; options: Array<{ id: string; label: string }> }
  /** `optionsFor` narrows the list to what the other values allow — the arrangements that can hold this many photos. */
  | {
      key: string;
      kind: 'select';
      label: string;
      options: Array<{ value: string; label: string }>;
      optionsFor?: (values: Record<string, unknown>) => Array<{ value: string; label: string }>;
      hintFor?: (values: Record<string, unknown>) => string | undefined;
    }
  | { key: string; kind: 'switch'; label: string; hint?: string }
  | { key: string; kind: 'sizes'; label: string }
  | { key: string; kind: 'platforms'; label: string }
  | { key: string; kind: 'slider'; label: string; min: number; max: number; step: number; format: (v: number) => string }
  /** A pick from a server catalogue (genres, voices, dub languages), fetched by the panel. 'myVoices' is only the workspace's own. */
  | { key: string; kind: 'catalogue'; label: string; source: 'genres' | 'voices' | 'myVoices' | 'languages' | 'sourceLanguages'; hint?: string }
  /** A file the tool works on, uploaded from the panel: the param holds the storage key. */
  | { key: string; kind: 'file'; label: string; accept: 'video' | 'audio' | 'image'; hint?: string; required?: boolean }
  /** A face for a "filmed by a customer" ad, from the PRESENTERS catalogue. */
  | { key: string; kind: 'presenter'; label: string; hint?: string }
  /**
   * Several photos, in the order they are tapped — the param holds a list of
   * storage keys. The order is the layout's order, so the numbers on the
   * thumbnails are not decoration: the first photo is the one that leads.
   */
  | { key: string; kind: 'photos'; label: string; min: number; max: number; hint?: string }
  /** One line per photo picked, in the same order: "Before", "After", a colour, a size. */
  | { key: string; kind: 'photoLabels'; label: string; forKey: string; hint?: string }
  /** A box that must be ticked before the button works — permission for a real person's face and voice. */
  | { key: string; kind: 'consent'; label: string; hint?: string };

/** A field shown only when the values say so. */
export type ConditionalField = Field & { showIf?: (values: Record<string, unknown>) => boolean };

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
  fields: ConditionalField[];
  defaults: Record<string, unknown>;
  /** A tool whose price depends on its settings names the CreditCost code; otherwise the capability's default applies. */
  costCodeFor?: (values: Record<string, unknown>) => string | undefined;
  /** Values the panel keeps for itself (which branch is showing); never sent as params. */
  localKeys?: string[];
  /**
   * The copy model proposes three directions for this product under the
   * named field (see StudioService.ideas); `fills` says which param each
   * part of an idea lands in.
   */
  ideas?: { under: string; fills: { prompt: string; motion?: string } };
  /** Last word on the params: nest or rename flat panel values before they are sent. */
  assemble?: (params: Record<string, unknown>) => Record<string, unknown>;
}

const SIZE_OPTIONS = Object.entries(EXPORT_SIZES).map(([id, s]) => ({
  id: id as ExportSize,
  label: `${s.aspect} · ${s.width}×${s.height}`,
  short: id.replace('_', ' '),
}));
export { SIZE_OPTIONS };

const IMAGE_STAGES = {
  queued: 'Waiting for a slot',
  preparing: 'Reading your photo',
  routing: 'Choosing the best model',
  generating: 'Placing your product in the scene',
  composing: 'Adding your name and price, cutting every size',
  storing: 'Saving your images',
  done: 'Done',
};

/** How many photos are in a `photos` field's value, whatever shape it arrived in. */
const countOf = (v: unknown): number => (Array.isArray(v) ? v.filter((k) => typeof k === 'string' && k).length : 0);

/** A presenter needs the customer-filmed format and an ad long enough to hold a testimonial and the product. */
const canPresent = (v: Record<string, unknown>): boolean => v.format === 'ugc' && Number(v.shots ?? 1) > 1;

export const TOOLS: Tool[] = [
  {
    id: 'scene',
    label: 'New scene',
    short: 'Scene',
    icon: 'studio',
    capability: 'IMAGE_EDIT',
    needsSource: true,
    narrative: IMAGE_STAGES,
    fields: [
      {
        key: 'prompt',
        kind: 'text',
        label: 'Where should the product be?',
        placeholder: 'On a marble kitchen counter in soft morning light',
        rows: 3,
        maxLength: 600,
        required: true,
        hint: 'Describe the surroundings. The product itself stays exactly as photographed.',
      },
      { key: 'aspect', kind: 'segment', label: 'Shape', options: ASPECTS.map((a) => ({ id: a, label: a })) },
      { key: 'sizes', kind: 'sizes', label: 'Export sizes' },
      { key: 'price', kind: 'text', label: 'Price on the image', placeholder: '₦12,000', maxLength: 40 },
      { key: 'businessName', kind: 'text', label: 'Business name on the image', placeholder: 'Leave blank to use your brand kit', maxLength: 80 },
    ],
    defaults: { preserveProduct: true, aspect: '1:1', sizes: ['feed_square', 'story'] },
    ideas: { under: 'prompt', fills: { prompt: 'prompt' } },
  },
  {
    id: 'background',
    label: 'Replace background',
    short: 'Background',
    icon: 'brand',
    capability: 'BACKGROUND_REPLACE',
    needsSource: true,
    narrative: { ...IMAGE_STAGES, generating: 'Building the new background' },
    fields: [
      { key: 'prompt', kind: 'text', label: 'New background', placeholder: 'Plain warm beige studio backdrop', rows: 2, maxLength: 400, required: true },
      { key: 'aspect', kind: 'segment', label: 'Shape', options: ASPECTS.map((a) => ({ id: a, label: a })) },
      { key: 'shadow', kind: 'switch', label: 'Natural shadow', hint: 'A soft contact shadow so it sits on the surface' },
      { key: 'relight', kind: 'switch', label: 'Match the lighting' },
    ],
    defaults: { aspect: '1:1', shadow: true, relight: true },
    ideas: { under: 'prompt', fills: { prompt: 'prompt' } },
  },
  {
    id: 'cutout',
    label: 'Remove background',
    short: 'Cut out',
    icon: 'swap',
    capability: 'BACKGROUND_REMOVE',
    needsSource: true,
    narrative: { ...IMAGE_STAGES, generating: 'Cutting out the product' },
    fields: [
      {
        key: 'background',
        kind: 'segment',
        label: 'Behind it',
        options: [
          { id: 'transparent', label: 'Transparent' },
          { id: '#FFFFFF', label: 'White' },
          { id: '#F3F3F3', label: 'Light grey' },
          { id: '#17131A', label: 'Black' },
        ],
      },
    ],
    defaults: { background: 'transparent' },
  },
  {
    id: 'enhance',
    label: 'Enhance',
    short: 'Enhance',
    icon: 'insights',
    capability: 'UPSCALE',
    needsSource: true,
    narrative: { ...IMAGE_STAGES, generating: 'Sharpening and enlarging' },
    fields: [
      {
        key: 'factor',
        kind: 'segment',
        label: 'Enlarge',
        options: [
          { id: '2', label: '2×' },
          { id: '4', label: '4×' },
        ],
      },
    ],
    defaults: { factor: 2 },
  },
  {
    id: 'restyle',
    label: 'Restyle',
    short: 'Restyle',
    icon: 'swap',
    capability: 'IMAGE_EDIT',
    needsSource: true,
    narrative: { ...IMAGE_STAGES, generating: 'Restyling your photo', composing: 'Cutting every size' },
    fields: [
      {
        key: 'prompt',
        kind: 'text',
        label: 'How should it look?',
        placeholder: 'Warm film look, golden hour, soft grain',
        rows: 3,
        maxLength: 600,
        required: true,
        hint: 'For a personal photo or a flyer you already have. The whole image can change.',
      },
      { key: 'aspect', kind: 'segment', label: 'Shape', options: ASPECTS.map((a) => ({ id: a, label: a })) },
      { key: 'sizes', kind: 'sizes', label: 'Export sizes' },
    ],
    defaults: { preserveProduct: false, aspect: '1:1', sizes: ['feed_square', 'story'], brand: { showPrice: false, showBusinessName: false } },
    ideas: { under: 'prompt', fills: { prompt: 'prompt' } },
  },
  {
    id: 'flyer',
    label: 'Make a flyer',
    short: 'Flyer',
    icon: 'today',
    capability: 'IMAGE_GENERATE',
    needsSource: false,
    narrative: {
      queued: 'Waiting for a slot',
      preparing: 'Reading your brief',
      routing: 'Choosing a model',
      generating: 'Designing your flyer',
      composing: 'Finishing',
      storing: 'Saving',
      done: 'Done',
    },
    fields: [
      {
        key: 'prompt',
        kind: 'text',
        label: 'What is it for?',
        placeholder: 'Birthday brunch for Tolu, Saturday 12 October, 1pm, Lekki. Bold, joyful, gold and green.',
        rows: 4,
        maxLength: 1200,
        required: true,
        hint: 'Say the occasion, the date, the place and the feeling. Words on the flyer come out best when you write them exactly.',
      },
      {
        key: 'style',
        kind: 'select',
        label: 'Style',
        options: [
          { value: 'bold poster, big type, flat colour', label: 'Bold poster' },
          { value: 'elegant, minimal, lots of space', label: 'Elegant' },
          { value: 'playful, illustrated, bright', label: 'Playful' },
          { value: 'photographic, premium, cinematic', label: 'Premium photo' },
          { value: 'traditional Nigerian motifs, ankara patterns, warm', label: 'Traditional' },
        ],
      },
      {
        key: 'aspect',
        kind: 'segment',
        label: 'Shape',
        options: [
          { id: '9:16', label: 'Status 9:16' },
          { id: '4:5', label: 'Feed 4:5' },
          { id: '1:1', label: 'Square' },
        ],
      },
    ],
    defaults: { aspect: '9:16', count: 1, style: 'bold poster, big type, flat colour' },
  },
  {
    id: 'collage',
    label: 'Photos in one',
    short: 'Collage',
    icon: 'collage',
    capability: 'COLLAGE',
    // It brings its own photos — several of them — so the canvas photo is not its source.
    needsSource: false,
    narrative: {
      queued: 'Waiting for a slot',
      preparing: 'Arranging your photos',
      composing: 'Laying them out',
      storing: 'Saving your collage',
      done: 'Done',
    },
    fields: [
      {
        key: 'sourceKeys',
        kind: 'photos',
        label: 'Your photos',
        min: COLLAGE_MIN_PHOTOS,
        max: COLLAGE_MAX_PHOTOS,
        hint: 'Tap in the order you want them. The first one leads.',
      },
      {
        key: 'layout',
        kind: 'select',
        label: 'Arrangement',
        // Only the arrangements that can hold what has been picked: a
        // before-and-after with five photos is not a choice worth offering.
        options: [{ value: 'auto', label: COLLAGE_LAYOUTS.auto.label }],
        optionsFor: (v) =>
          collageLayoutsFor(countOf(v.sourceKeys)).map((k) => ({ value: k, label: COLLAGE_LAYOUTS[k].label })) || [
            { value: 'auto', label: COLLAGE_LAYOUTS.auto.label },
          ],
        hintFor: (v) => {
          const key = String(v.layout ?? 'auto') as CollageLayout;
          return COLLAGE_LAYOUTS[key]?.note;
        },
      },
      {
        key: 'aspect',
        kind: 'segment',
        label: 'Shape',
        options: [
          { id: '1:1', label: 'Square' },
          { id: '4:5', label: 'Feed 4:5' },
          { id: '9:16', label: 'Status 9:16' },
        ],
      },
      { key: 'labels', kind: 'photoLabels', forKey: 'sourceKeys', label: 'A word on each photo', hint: 'Optional — leave any of them blank.' },
      {
        key: 'background',
        kind: 'select',
        label: 'Behind the photos',
        options: [
          { value: '#FFFFFF', label: 'White' },
          { value: '#F6F1EA', label: 'Warm cream' },
          { value: '#17131A', label: 'Near black' },
          { value: 'brand', label: 'Your brand colour' },
        ],
      },
      { key: 'gap', kind: 'slider', label: 'Space between', min: 0, max: 40, step: 2, format: (v) => (v === 0 ? 'Edge to edge' : `${v}`) },
      { key: 'rounded', kind: 'switch', label: 'Rounded corners' },
      { key: 'sizes', kind: 'sizes', label: 'Export sizes' },
      { key: 'price', kind: 'text', label: 'Price on the image', placeholder: '₦12,000', maxLength: 40 },
      { key: 'businessName', kind: 'text', label: 'Business name on the image', placeholder: 'Leave blank to use your brand kit', maxLength: 80 },
    ],
    defaults: {
      sourceKeys: [],
      layout: 'auto',
      aspect: '1:1',
      gap: 14,
      background: '#FFFFFF',
      rounded: true,
      labels: [],
      sizes: ['feed_square', 'story'],
    },
    assemble: (p) => {
      const keys = Array.isArray(p.sourceKeys) ? (p.sourceKeys as string[]).filter(Boolean) : [];
      // An arrangement that no longer fits — two photos became four after
      // "before and after" was chosen — quietly becomes the automatic one
      // rather than being refused by the API.
      const layout = String(p.layout ?? 'auto') as CollageLayout;
      const fits = collageLayoutsFor(keys.length);
      // Labels are per photo and positional: trim to the photos that exist,
      // and send nothing at all when every one of them is blank.
      const labels = (Array.isArray(p.labels) ? (p.labels as unknown[]) : []).slice(0, keys.length).map((l) => String(l ?? '').trim());
      const out: Record<string, unknown> = { ...p, sourceKeys: keys, layout: fits.includes(layout) ? layout : 'auto' };
      if (labels.some((l) => l.length > 0)) out.labels = labels;
      else delete out.labels;
      return out;
    },
  },
  {
    id: 'copy',
    label: 'Write the listing',
    short: 'Copy',
    icon: 'library',
    capability: 'TEXT_GENERATE',
    needsSource: false,
    narrative: {
      queued: 'Waiting for a slot',
      preparing: 'Looking at your photo',
      routing: 'Choosing a writer',
      generating: 'Writing your listing and captions',
      composing: 'Checking every platform limit',
      storing: 'Saving',
      done: 'Done',
    },
    fields: [
      { key: 'productName', kind: 'text', label: 'Product name', placeholder: 'Ankara tote bag', maxLength: 120 },
      {
        key: 'details',
        kind: 'text',
        label: 'Anything the photo does not show',
        placeholder: 'Handmade in Lagos, fits a 14" laptop, three colours',
        rows: 3,
        maxLength: 800,
      },
      { key: 'price', kind: 'text', label: 'Price', placeholder: '₦12,000', maxLength: 40 },
      {
        key: 'language',
        kind: 'select',
        label: 'Language',
        options: [
          { value: 'en', label: 'English' },
          { value: 'en-NG', label: 'Nigerian English' },
          { value: 'pcm', label: 'Pidgin' },
          { value: 'yo', label: 'Yoruba' },
          { value: 'ig', label: 'Igbo' },
          { value: 'ha', label: 'Hausa' },
          { value: 'fr', label: 'French' },
          { value: 'sw', label: 'Swahili' },
        ],
      },
      { key: 'platforms', kind: 'platforms', label: 'Captions for' },
    ],
    defaults: { task: 'product_copy', language: 'en', platforms: ['instagram', 'whatsapp_status'] },
  },
  {
    id: 'video',
    label: 'Make a video',
    short: 'Video',
    icon: 'publish',
    capability: 'IMAGE_TO_VIDEO',
    needsSource: true,
    narrative: {
      queued: 'Waiting for a video slot',
      preparing: 'Reading your photo',
      routing: 'Choosing a video model',
      generating: 'Rendering — this takes a few minutes',
      waiting: 'Shots are rendering',
      composing: 'Stitching the shots, adding captions and the end card',
      storing: 'Saving your video',
      done: 'Done',
    },
    fields: [
      {
        key: 'shots',
        kind: 'segment',
        label: 'Length',
        options: [
          { id: '1', label: 'Reel · 5–8 s' },
          { id: '2', label: '15 s' },
          { id: '4', label: '30 s' },
          { id: '6', label: '45 s' },
          { id: '8', label: '60 s' },
        ],
      },
      {
        key: 'format',
        kind: 'select',
        label: 'Ad format',
        options: [
          { value: 'reveal', label: 'Product reveal' },
          { value: 'benefits', label: 'Three benefits' },
          { value: 'before_after', label: 'Before and after' },
          { value: 'unboxing', label: 'Unboxing' },
          { value: 'price_drop', label: 'Price drop' },
          { value: 'ugc', label: 'Filmed by a customer' },
        ],
      },
      {
        key: 'prompt',
        kind: 'text',
        label: 'What happens',
        placeholder: 'The camera slowly pushes in as light sweeps across the fabric',
        rows: 3,
        maxLength: 600,
        required: true,
        hint: 'For an ad, this is your direction to the planner; each shot gets its own prompt.',
      },
      { key: 'motion', kind: 'text', label: 'Camera', placeholder: 'slow push-in · orbit · tilt up · rack focus', maxLength: 200 },
      {
        key: 'durationSec',
        kind: 'segment',
        label: 'Reel length',
        options: [
          { id: '5', label: '5 s' },
          { id: '8', label: '8 s' },
        ],
      },
      {
        key: 'aspect',
        kind: 'segment',
        label: 'Shape',
        options: [
          { id: '9:16', label: '9:16' },
          { id: '1:1', label: '1:1' },
          { id: '16:9', label: '16:9' },
        ],
      },
      { key: 'productName', kind: 'text', label: 'Product name', placeholder: 'For the end card', maxLength: 120 },
      { key: 'price', kind: 'text', label: 'Price', placeholder: '₦12,000 — shown on the end card', maxLength: 40 },
      // ---- a person talking to camera: only for "filmed by a customer", 15 s and up
      {
        key: 'presenterKind',
        kind: 'segment',
        label: 'Someone talking to camera',
        options: [
          { id: 'none', label: 'No one' },
          { id: 'stock', label: 'A presenter' },
          { id: 'photo', label: 'Me, from a photo' },
        ],
        showIf: canPresent,
      },
      {
        key: 'presenterKey',
        kind: 'presenter',
        label: 'Who',
        hint: 'They open the ad with a short, honest testimonial, then the product shots follow. Costs more than a plain ad.',
        showIf: (v) => canPresent(v) && v.presenterKind === 'stock',
      },
      {
        key: 'presenterPhotoKey',
        kind: 'file',
        accept: 'image',
        label: 'A photo of you',
        required: true,
        hint: 'A clear face looking at the camera, good light, nothing over the mouth. Shoulders up is best.',
        showIf: (v) => canPresent(v) && v.presenterKind === 'photo',
      },
      {
        key: 'presenterConsent',
        kind: 'consent',
        label: 'This is me, or someone who has agreed to appear',
        hint: 'A face is personal. We only animate a photo of a person who has said yes.',
        showIf: (v) => canPresent(v) && v.presenterKind === 'photo',
      },
      {
        key: 'presenterVoiceId',
        kind: 'catalogue',
        source: 'voices',
        label: 'Their voice',
        hint: 'A catalogue voice, or your own from Settings → Your voice.',
        showIf: (v) => canPresent(v) && v.presenterKind !== 'none',
      },
      {
        key: 'presenterScript',
        kind: 'text',
        label: 'What they say',
        placeholder: 'Leave blank and we write a short testimonial from your brief and the product.',
        rows: 3,
        maxLength: 600,
        hint: 'About 25 words is 10 seconds.',
        showIf: (v) => canPresent(v) && v.presenterKind !== 'none',
      },
    ],
    defaults: { shots: 1, format: 'reveal', durationSec: 5, aspect: '9:16', audio: false, presenterKind: 'none' },
    localKeys: ['presenterKind'],
    costCodeFor: (v) => {
      const plan = adPlan(Number(v.shots));
      if (!plan) return undefined;
      return canPresent(v) && v.presenterKind && v.presenterKind !== 'none' ? presenterCostCode(plan.costCode) : plan.costCode;
    },
    assemble: (p) => {
      const kind = p.presenterKind;
      const out = { ...p };
      for (const k of ['presenterKind', 'presenterKey', 'presenterPhotoKey', 'presenterConsent', 'presenterVoiceId', 'presenterScript']) delete out[k];
      if (canPresent(p) && (kind === 'stock' || kind === 'photo')) {
        out.presenter = {
          kind,
          key: kind === 'stock' ? p.presenterKey : undefined,
          photoKey: kind === 'photo' ? p.presenterPhotoKey : undefined,
          consent: kind === 'photo' ? p.presenterConsent === true : undefined,
          voiceId: p.presenterVoiceId || undefined,
          script: typeof p.presenterScript === 'string' && p.presenterScript.trim() ? p.presenterScript.trim() : undefined,
        };
      }
      return out;
    },
    ideas: { under: 'prompt', fills: { prompt: 'prompt', motion: 'motion' } },
  },
  {
    id: 'music',
    label: 'Make a song',
    short: 'Song',
    icon: 'music',
    capability: 'MUSIC',
    needsSource: false,
    narrative: {
      queued: 'Waiting for a slot',
      preparing: 'Writing the words',
      routing: 'Choosing a studio',
      generating: 'Composing — a full song takes a minute or two',
      composing: 'Mixing',
      storing: 'Cutting your preview',
      done: 'Done',
    },
    fields: [
      { key: 'genre', kind: 'catalogue', source: 'genres', label: 'Genre', hint: 'From Afrobeats to cumbia — pick the sound.' },
      {
        key: 'brief',
        kind: 'text',
        label: 'What is the song about?',
        placeholder: 'A birthday song for my sister Kemi who loves jollof and dancing',
        rows: 3,
        maxLength: 2000,
        required: true,
      },
      { key: 'title', kind: 'text', label: 'Title', placeholder: 'Leave blank and we will name it', maxLength: 120 },
      {
        key: 'vocal',
        kind: 'segment',
        label: 'Voice',
        options: [
          { id: 'female', label: 'Female' },
          { id: 'male', label: 'Male' },
          { id: 'duet', label: 'Duet' },
          { id: 'choir', label: 'Choir' },
          { id: 'instrumental', label: 'No vocals' },
        ],
      },
      {
        key: 'language',
        kind: 'select',
        label: 'Lyrics in',
        options: [
          { value: 'en', label: 'English' },
          { value: 'pcm', label: 'Pidgin' },
          { value: 'yo', label: 'Yoruba' },
          { value: 'ig', label: 'Igbo' },
          { value: 'ha', label: 'Hausa' },
          { value: 'tw', label: 'Twi' },
          { value: 'sw', label: 'Swahili' },
          { value: 'zu', label: 'Zulu' },
          { value: 'fr', label: 'French' },
          { value: 'pt', label: 'Portuguese' },
          { value: 'es', label: 'Spanish' },
          { value: 'ar', label: 'Arabic' },
          { value: 'hi', label: 'Hindi' },
          { value: 'ko', label: 'Korean' },
        ],
      },
      {
        key: 'mood',
        kind: 'text',
        label: 'Mood',
        placeholder: 'Tap a few, or type your own',
        maxLength: 60,
        suggestions: ['joyful', 'romantic', 'confident', 'nostalgic', 'celebratory', 'heartfelt', 'calm', 'hopeful', 'proud', 'cheeky', 'grateful', 'party'],
      },
      {
        key: 'tempo',
        kind: 'segment',
        label: 'Tempo',
        options: [
          { id: 'slow', label: 'Slow' },
          { id: 'mid', label: 'Mid' },
          { id: 'fast', label: 'Fast' },
        ],
      },
      {
        key: 'durationSec',
        kind: 'segment',
        label: 'Length',
        options: [
          { id: '60', label: '1 min' },
          { id: '120', label: '2 min' },
          { id: '180', label: '3 min' },
        ],
      },
      {
        key: 'lyrics',
        kind: 'text',
        label: 'Your words, a story or a memory',
        placeholder:
          'Leave blank and we write the song from the brief. Or tell us a story or a memory — how the business started, who it is for, a day you will not forget. Or give us a hook, a few lines, or full lyrics with [Verse] and [Chorus].',
        rows: 6,
        maxLength: 3000,
        hint: 'A story becomes the song — names, places and moments kept. A line or two is kept word for word with the rest written around it. Full lyrics are sung as written.',
      },
      {
        key: 'lyricsMode',
        kind: 'segment',
        label: 'With what you wrote',
        options: [
          { id: 'auto', label: 'Decide for me' },
          { id: 'inspire', label: 'Turn my story into a song' },
          { id: 'complete', label: 'Keep my lines, write the rest' },
          { id: 'exact', label: 'Sing it exactly' },
        ],
      },
      {
        key: 'singer',
        kind: 'segment',
        label: 'Sung by',
        options: [
          { id: 'model', label: 'The studio singer' },
          { id: 'me', label: 'Me — my own voice' },
        ],
      },
      {
        key: 'voiceId',
        kind: 'catalogue',
        source: 'myVoices',
        label: 'Which of your voices',
        hint: 'Experimental. The studio sings the song, then the voice is swapped for yours — the melody and timing stay, the voice becomes yours. Costs more. Record a voice under Settings → Your voice.',
        showIf: (v) => v.singer === 'me',
      },
    ],
    defaults: { vocal: 'female', language: 'en', tempo: 'mid', durationSec: 120, lyricsMode: 'auto', singer: 'model' },
    costCodeFor: (v) => (v.singer === 'me' ? 'audio.music.preview.my_voice' : undefined),
  },
  {
    id: 'voice',
    label: 'Record a voiceover',
    short: 'Voice',
    icon: 'mic',
    capability: 'VOICEOVER',
    needsSource: false,
    narrative: {
      queued: 'Waiting for a slot',
      preparing: 'Reading your script',
      routing: 'Booking the voice',
      generating: 'Recording',
      storing: 'Saving',
      done: 'Done',
    },
    fields: [
      {
        key: 'voiceId',
        kind: 'catalogue',
        source: 'voices',
        label: 'Voice',
        hint: 'Nigerian, Kenyan and South African English voices are here too. Your own voice, once recorded under Settings, is at the top.',
      },
      {
        key: 'script',
        kind: 'text',
        label: 'Script',
        placeholder: 'Fresh ankara bags, now in stock. Message us to order — delivery across Lagos today.',
        rows: 5,
        maxLength: 4000,
        required: true,
        hint: 'About 150 words is a minute.',
      },
      {
        key: 'style',
        kind: 'segment',
        label: 'Read it',
        options: [
          { id: 'natural', label: 'Natural' },
          { id: 'ad', label: 'Ad' },
          { id: 'energetic', label: 'Upbeat' },
          { id: 'calm', label: 'Calm' },
          { id: 'story', label: 'Story' },
        ],
      },
      { key: 'speed', kind: 'slider', label: 'Speed', min: 0.8, max: 1.2, step: 0.05, format: (v) => `${v.toFixed(2)}×` },
    ],
    defaults: { style: 'natural', speed: 1, language: 'en' },
  },
  {
    id: 'translate',
    label: 'Translate a video',
    short: 'Translate',
    icon: 'translate',
    capability: 'DUB',
    needsSource: false,
    narrative: {
      queued: 'Waiting for a video slot',
      preparing: 'Listening to your video',
      routing: 'Choosing a studio that speaks the language',
      generating: 'Dubbing — a minute of video takes a few minutes',
      composing: 'Matching the lips to the new voice',
      storing: 'Saving your video',
      done: 'Done',
    },
    fields: [
      {
        key: 'sourceKey',
        kind: 'file',
        accept: 'video',
        label: 'The video',
        required: true,
        hint: 'MP4 or MOV, up to five minutes. Someone talking to camera works best.',
      },
      { key: 'targetLanguage', kind: 'catalogue', source: 'languages', label: 'Speak it in', hint: 'The same voice, in another language.' },
      { key: 'sourceLanguage', kind: 'catalogue', source: 'sourceLanguages', label: 'It is currently in' },
      { key: 'lipsync', kind: 'switch', label: 'Move the lips to match', hint: 'Costs more; the mouth is re-animated for the new words.' },
      {
        key: 'speakers',
        kind: 'segment',
        label: 'People speaking',
        options: [
          { id: '0', label: 'Let it count' },
          { id: '1', label: '1' },
          { id: '2', label: '2' },
          { id: '3', label: '3+' },
        ],
      },
      { key: 'keepBackground', kind: 'switch', label: 'Keep the music and background sound' },
      {
        key: 'consent',
        kind: 'consent',
        label: 'I have permission to use this person’s face and voice',
        hint: 'Dubbing clones the voice. Only your own videos, or ones you have been given the right to use.',
      },
    ],
    defaults: { sourceLanguage: 'auto', lipsync: false, speakers: 0, keepBackground: true, quality: 'speed', consent: false },
    costCodeFor: (v) => (v.lipsync === true ? 'video.translate_lipsync' : undefined),
  },
  {
    id: 'lipsync',
    label: 'Lip-sync new words',
    short: 'Lip-sync',
    icon: 'lips',
    capability: 'LIPSYNC',
    needsSource: false,
    narrative: {
      queued: 'Waiting for a video slot',
      preparing: 'Recording the script',
      routing: 'Choosing a studio',
      generating: 'Re-animating the mouth — a few minutes',
      storing: 'Saving your video',
      done: 'Done',
    },
    fields: [
      {
        key: 'sourceKey',
        kind: 'file',
        accept: 'video',
        label: 'The video',
        required: true,
        hint: 'MP4 or MOV, up to three minutes, one face clearly visible.',
      },
      {
        key: 'mode',
        kind: 'segment',
        label: 'The new words come from',
        options: [
          { id: 'script', label: 'A script we record' },
          { id: 'audio', label: 'An audio file' },
        ],
      },
      { key: 'voiceId', kind: 'catalogue', source: 'voices', label: 'Voice', showIf: (v) => v.mode !== 'audio' },
      {
        key: 'script',
        kind: 'text',
        label: 'Script',
        placeholder: 'Same great bags, now with delivery across Lagos in one day.',
        rows: 4,
        maxLength: 4000,
        showIf: (v) => v.mode !== 'audio',
      },
      { key: 'audioKey', kind: 'file', accept: 'audio', label: 'The audio', hint: 'MP3, M4A or WAV, up to 30 MB.', showIf: (v) => v.mode === 'audio' },
      {
        key: 'quality',
        kind: 'segment',
        label: 'Quality',
        options: [
          { id: 'speed', label: 'Quick' },
          { id: 'precision', label: 'Best' },
        ],
      },
      {
        key: 'consent',
        kind: 'consent',
        label: 'I have permission to use this person’s face',
        hint: 'Only your own videos, or ones you have been given the right to use.',
      },
    ],
    defaults: { mode: 'script', language: 'en', quality: 'speed', consent: false },
    localKeys: ['mode'],
  },
];

export const toolById = (id: string | null | undefined): Tool => TOOLS.find((t) => t.id === id) ?? TOOLS[0]!;

/**
 * A tool that carries its own source: the video it was given to translate,
 * the several photos it was given to arrange. The canvas photo belongs to
 * every OTHER tool, and must not be slipped into these ones' params.
 */
export const bringsItsOwnSource = (tool: Tool): boolean => tool.fields.some((f) => (f.kind === 'file' && f.key === 'sourceKey') || f.kind === 'photos');

/** The photo a result card shows for a tool that brought several: the first one, which is the one that leads. */
export const cardSourceFor = (tool: Tool, params: Record<string, unknown>): string | undefined => {
  const photos = tool.fields.find((f) => f.kind === 'photos');
  if (photos) {
    const keys = params[photos.key];
    return Array.isArray(keys) ? ((keys as string[]).find(Boolean) ?? undefined) : undefined;
  }
  return typeof params.sourceKey === 'string' ? params.sourceKey : undefined;
};

/** Segments and selects carry strings; some params are numbers. Coerce by the tool's defaults. */
export function coerceParams(tool: Tool, values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...tool.defaults, ...values };
  for (const [k, d] of Object.entries(tool.defaults)) {
    if (typeof d === 'number' && typeof out[k] === 'string') out[k] = Number(out[k]);
  }
  // A hidden field's value is not sent: the other branch's script does not ride along with an audio file.
  for (const f of tool.fields) if (f.showIf && !f.showIf(out)) delete out[f.key];
  // The panel's own switches (which branch is showing) are not params.
  // What the last run wrote for itself (the lyrics it composed, the shot plan,
  // the presenter it filmed) is not a setting: a repeat must ask for new work,
  // not replay the old. The API drops these too; this keeps the panel honest.
  for (const k of PIPELINE_WRITTEN_KEYS) delete out[k];
  const assembled = tool.assemble ? tool.assemble(out) : out;
  for (const k of tool.localKeys ?? []) delete assembled[k];
  for (const [k, v] of Object.entries(assembled)) if (v === '' || v === undefined || (k === 'consent' && v !== true)) delete assembled[k];
  return assembled;
}

/** What stops the button: a required file, an empty required text, a catalogue with nothing picked, or a consent box left unticked. */
export function missingFor(tool: Tool, values: Record<string, unknown>): string | null {
  for (const f of tool.fields) {
    if (f.showIf && !f.showIf(values)) continue;
    const v = values[f.key];
    if (f.kind === 'file' && f.required && !String(v ?? '').trim()) return `Add ${f.label.toLowerCase()} first.`;
    if (f.kind === 'text' && f.required && !String(v ?? '').trim()) return 'Fill in the required field.';
    if (f.kind === 'catalogue' && !String(v ?? '').trim()) return `Pick ${f.label.toLowerCase()}.`;
    if (f.kind === 'presenter' && !String(v ?? '').trim()) return 'Pick who talks to camera.';
    if (f.kind === 'consent' && v !== true) return 'Tick the permission box first.';
    if (f.kind === 'photos') {
      const n = countOf(v);
      if (n < f.min) return n === 0 ? `Pick at least ${f.min} photos.` : `${f.min - n} more ${f.min - n === 1 ? 'photo' : 'photos'} to go.`;
      if (n > f.max) return `That is ${n} photos — ${f.max} is the most that fits.`;
    }
  }
  if (tool.id === 'lipsync' && values.mode === 'audio' && !String(values.audioKey ?? '').trim()) return 'Add the audio first.';
  if (tool.id === 'lipsync' && values.mode !== 'audio' && !String(values.script ?? '').trim()) return 'Write the script first.';
  return null;
}

export const PLATFORM_OPTIONS = [
  { id: 'instagram', label: 'Instagram' },
  { id: 'whatsapp_status', label: 'WhatsApp Status' },
  { id: 'tiktok', label: 'TikTok' },
  { id: 'facebook', label: 'Facebook' },
  { id: 'x', label: 'X' },
];
