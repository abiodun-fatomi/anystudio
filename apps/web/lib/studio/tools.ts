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
  BATCH_MAX,
  MODEL_POSES,
  MODEL_PRESETS,
  MODEL_SCENES,
  PRODUCT_REFERENCE_ANGLES,
  preset,
  presetCapability,
  productMode,
  productModeCostCode,
  productShotCostCode,
  SHOT_SIZES,
  SHOT_SIZE_KEYS,
  TAKES_SHOT_SIZE,
  TEXT_KINDS,
  TEXT_KIND_KEYS,
  OFFERED_PRODUCT_MODES,
  presenterCostCode,
} from '@anystudio/shared';
import type { IconName } from '@/components/shell/icons';

export type ToolId =
  | 'scene'
  | 'background'
  | 'cutout'
  | 'enhance'
  | 'copy'
  | 'video'
  | 'flyer'
  | 'collage'
  | 'shots'
  | 'batch'
  | 'restyle'
  | 'music'
  | 'voice'
  | 'translate'
  | 'lipsync';

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
  /** `note` on an option is the sentence shown under the control once it is chosen. */
  | { key: string; kind: 'segment'; label: string; options: Array<{ id: string; label: string; note?: string }> }
  /**
   * One switch for "put my shop on this one", with a sentence under it naming
   * exactly what will be stamped. The fine-grained settings live on the Brand
   * kit page; this is the per-picture answer to one question.
   */
  | { key: 'brand'; kind: 'brand'; label: string }
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
  /**
   * Looks shown as tiles you tap, grouped. Tapping one fills the other
   * fields from the preset — it is a first draft, not a lock, and every word
   * it writes stays editable underneath.
   */
  | { key: string; kind: 'presets'; label: string; hint?: string }
  /** The merchant shots as tiles: on a model, ghost mannequin, flat lay, pressed. Named the way a merchant names them. */
  | { key: string; kind: 'modes'; label: string; hint?: string }
  /** Extra photos of the same product from other angles — the cheapest way to keep it exact. */
  | { key: string; kind: 'angles'; label: string; max: number; hint?: string }
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
  /**
   * A tool whose capability depends on what was chosen. "Plain white" is a
   * cut-out flattened onto a colour — no model, 2 credits, no drift — while
   * "Market stall" is a scene a model builds. One tool, one button, and the
   * seller never learns the difference; the quote and the request both follow
   * this.
   */
  capabilityFor?: (values: Record<string, unknown>) => Capability;
  /**
   * How many units this will be charged for — a batch is one row priced per
   * photo, so the panel must quote the folder rather than one picture.
   */
  quantityFor?: (values: Record<string, unknown>) => number;
  /** Needs a source photo on the canvas. Copy can work from a photo or from text alone. */
  needsSource: boolean;
  /**
   * A tool that needs the canvas photo only for some settings — a flyer built
   * FROM your photo needs one, a flyer drawn from a sentence does not.
   */
  needsSourceFor?: (values: Record<string, unknown>) => boolean;
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
    capabilityFor: (v) => {
      const chosen = preset(v.preset as string);
      return chosen ? presetCapability(chosen) : 'IMAGE_EDIT';
    },
    needsSource: true,
    narrative: IMAGE_STAGES,
    fields: [
      { key: 'preset', kind: 'presets', label: 'Pick a look', hint: 'Tap one to start. You can change the words underneath afterwards.' },
      {
        key: 'prompt',
        kind: 'text',
        label: 'Where should the product be?',
        placeholder: 'On a marble kitchen counter in soft morning light',
        rows: 3,
        maxLength: 600,
        required: true,
        hint: 'Describe the surroundings. The product itself stays exactly as photographed.',
        // A cut-out onto a flat colour has nothing to describe.
        showIf: (v) => preset(v.preset as string)?.kind !== 'cut',
      },
      {
        key: 'aspect',
        kind: 'segment',
        label: 'Shape',
        options: ASPECTS.map((a) => ({ id: a, label: a })),
        showIf: (v) => preset(v.preset as string)?.kind !== 'cut',
      },
      { key: 'sizes', kind: 'sizes', label: 'Export sizes', showIf: (v) => preset(v.preset as string)?.kind !== 'cut' },
      {
        key: 'price',
        kind: 'text',
        label: 'Price on the image',
        placeholder: '₦12,000',
        maxLength: 40,
        showIf: (v) => preset(v.preset as string)?.kind !== 'cut',
      },
      {
        key: 'businessName',
        kind: 'text',
        label: 'Business name on the image',
        placeholder: 'Leave blank to use your brand kit',
        maxLength: 80,
        showIf: (v) => preset(v.preset as string)?.kind !== 'cut',
      },
      // A cut-out is a product on transparency, meant to be placed into
      // something else — stamping a shop name on it would ruin the only thing
      // it is for. Everywhere else, the switch.
      { key: 'brand', kind: 'brand', label: 'Put my shop on it', showIf: (v) => preset(v.preset as string)?.kind !== 'cut' },
    ],
    defaults: { preserveProduct: true, aspect: '1:1', sizes: ['feed_square', 'story'] },
    ideas: { under: 'prompt', fills: { prompt: 'prompt' } },
    localKeys: ['preset'],
    // A cut-out takes a colour and nothing else; a scene takes everything but the colour.
    assemble: (p) => {
      const chosen = preset(p.preset as string);
      if (chosen?.kind === 'cut') return { background: chosen.params.background };
      const out = { ...p };
      delete out.background;
      return out;
    },
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
    // A flyer built from your photo is an EDIT of that photo; a flyer from a
    // sentence is a new picture. Same tool, same button, different request.
    capabilityFor: (v) => (v.useSource === 'new' ? 'IMAGE_GENERATE' : 'IMAGE_EDIT'),
    needsSource: false,
    needsSourceFor: (v) => v.useSource !== 'new',
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
        key: 'useSource',
        kind: 'segment',
        label: 'The picture',
        options: [
          { id: 'photo', label: 'Use my photo' },
          { id: 'new', label: 'Draw a new one' },
        ],
      },
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
    defaults: { useSource: 'photo', aspect: '9:16', count: 1, style: 'bold poster, big type, flat colour', sizes: ['story', 'feed_portrait'] },
    localKeys: ['useSource'],
    assemble: (p) => {
      if (p.useSource === 'new') {
        const { sizes: _sizes, ...rest } = p;
        return rest;
      }
      // The edit path: the style belongs in the prompt, and the person or
      // product in the photo is held exactly as photographed.
      const style = typeof p.style === 'string' && p.style ? ` Style: ${p.style}.` : '';
      return {
        prompt: `Design a flyer around the subject of this photo. ${String(p.prompt ?? '')}${style} Keep the person or product exactly as photographed; build the flyer around them.`,
        preserveProduct: true,
        aspect: p.aspect,
        sizes: p.sizes,
      };
    },
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
      {
        key: 'fit',
        kind: 'segment',
        label: 'The photos',
        options: [
          { id: 'fit', label: 'Whole photo' },
          { id: 'fill', label: 'Fill the tile' },
        ],
      },
      {
        key: 'focus',
        kind: 'segment',
        label: 'Crop from',
        options: [
          { id: 'auto', label: 'Find the subject' },
          { id: 'top', label: 'Top' },
          { id: 'centre', label: 'Middle' },
          { id: 'bottom', label: 'Bottom' },
        ],
        // Only a filled tile crops; a whole photo has nothing to crop from.
        showIf: (v) => v.fit === 'fill',
      },
      { key: 'gap', kind: 'slider', label: 'Space between', min: 0, max: 40, step: 2, format: (v) => (v === 0 ? 'Edge to edge' : `${v}`) },
      { key: 'rounded', kind: 'switch', label: 'Rounded corners' },
      { key: 'sizes', kind: 'sizes', label: 'Export sizes' },
      { key: 'price', kind: 'text', label: 'Price on the image', placeholder: '₦12,000', maxLength: 40 },
      { key: 'businessName', kind: 'text', label: 'Business name on the image', placeholder: 'Leave blank to use your brand kit', maxLength: 80 },
      // The switch that puts a merchant's shop on the picture. Its sentence is
      // built from the brand kit and whatever price was typed above, so it
      // sits after the price to read in order.
      { key: 'brand', kind: 'brand', label: 'Put my shop on it' },
    ],
    defaults: {
      sourceKeys: [],
      layout: 'auto',
      aspect: '1:1',
      fit: 'fit',
      focus: 'auto',
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
    id: 'shots',
    label: 'Merchant shots',
    short: 'Shots',
    icon: 'store',
    capability: 'PRODUCT_SHOT',
    needsSource: true,
    narrative: {
      queued: 'Waiting for a slot',
      preparing: 'Reading your photo',
      generating: 'Making the shot',
      composing: 'Adding your name and price, cutting every size',
      storing: 'Saving your images',
      done: 'Done',
    },
    // Priced by what was asked for: a model wearing it costs more than a press,
    // and a 4K render costs more than a 1K one. The server derives this again
    // from the params it validated; this is only so the price shown is right.
    costCodeFor: (v) => productShotCostCode(v.mode as string, v.shotSize as string),
    fields: [
      { key: 'mode', kind: 'modes', label: 'What do you need?' },
      {
        key: 'model',
        kind: 'select',
        label: 'Who wears it',
        options: [{ value: 'random', label: 'Any model' }],
        optionsFor: () => [
          { value: 'random', label: 'Any model' },
          { value: 'custom', label: 'My own model (a photo)' },
          ...MODEL_PRESETS.map((m) => ({ value: m, label: m[0]!.toUpperCase() + m.slice(1) })),
        ],
        showIf: (v) => v.mode === 'on_model',
      },
      {
        key: 'modelPhotoKey',
        kind: 'file',
        accept: 'image',
        label: 'Photo of the person',
        hint: 'One clear photo. Every item you shoot after this can use the same person.',
        showIf: (v) => v.mode === 'on_model' && v.model === 'custom',
      },
      {
        key: 'scene',
        kind: 'select',
        label: 'Where',
        options: [{ value: 'random', label: 'Anywhere' }],
        optionsFor: () => MODEL_SCENES.map((s) => ({ value: s, label: s === 'random' ? 'Anywhere' : s })),
        showIf: (v) => v.mode === 'on_model',
      },
      {
        key: 'pose',
        kind: 'select',
        label: 'Pose',
        options: [{ value: 'random', label: 'Any pose' }],
        optionsFor: () => MODEL_POSES.map((s) => ({ value: s, label: s === 'random' ? 'Any pose' : s })),
        showIf: (v) => v.mode === 'on_model',
      },
      {
        // Named for what the picture is FOR, because "Premium" tells a seller
        // nothing and reads like a sales page. Bigger costs more and takes
        // longer, so the smallest is the default: a Status post wants neither.
        key: 'shotSize',
        kind: 'segment',
        label: 'What is it for?',
        options: SHOT_SIZE_KEYS.map((k) => ({ id: k, label: SHOT_SIZES[k].label, note: SHOT_SIZES[k].note })),
        showIf: (v) => TAKES_SHOT_SIZE.includes(v.mode as never),
      },
      {
        // Named for the thing, not the category: "added on top" is what a
        // supplier's watermark is, and nobody thinks of it as artificial text.
        key: 'textKind',
        kind: 'segment',
        label: 'Which writing?',
        options: TEXT_KIND_KEYS.map((k) => ({ id: k, label: TEXT_KINDS[k].label, note: TEXT_KINDS[k].note })),
        showIf: (v) => v.mode === 'text_removal',
      },
      {
        key: 'prompt',
        kind: 'text',
        label: 'What should be different?',
        placeholder: 'Remove the hanger',
        rows: 2,
        maxLength: 600,
        required: true,
        hint: 'One change at a time works better than a list.',
        showIf: (v) => v.mode === 'edit',
      },
      {
        key: 'subject',
        kind: 'segment',
        label: 'What is it?',
        options: [
          { id: 'auto', label: 'Anything' },
          { id: 'food', label: 'Food' },
          { id: 'car', label: 'A vehicle' },
        ],
        showIf: (v) => v.mode === 'beautify',
      },
      {
        key: 'prompt',
        kind: 'text',
        label: 'Anything to add?',
        placeholder: 'Leave blank and we decide',
        rows: 2,
        maxLength: 600,
        // Optional on every mode that does not require it. Words steer; they never gate.
        showIf: (v) => !['retouch', 'recolor', 'ironing'].includes(String(v.mode ?? '')),
      },
      {
        key: 'angleKeys',
        kind: 'angles',
        label: 'More angles of the same item',
        max: PRODUCT_REFERENCE_ANGLES.max,
        hint: 'Optional, and the best way to keep your item exact on a model. The back, the label, a close-up.',
        // The vendor reads extra angles only for the on-a-model shot. Offering
        // them elsewhere would be asking for uploads nothing will look at.
        showIf: (v) => v.mode === 'on_model',
      },
      {
        key: 'shadow',
        kind: 'segment',
        label: 'Shadow',
        options: [
          { id: 'soft', label: 'Soft' },
          { id: 'hard', label: 'Hard' },
          { id: 'floating', label: 'Floating' },
          { id: 'none', label: 'None' },
        ],
      },
      { key: 'aspect', kind: 'segment', label: 'Shape', options: ASPECTS.map((a) => ({ id: a, label: a })) },
      { key: 'sizes', kind: 'sizes', label: 'Export sizes' },
      { key: 'price', kind: 'text', label: 'Price on the image', placeholder: '\u20a612,000', maxLength: 40 },
      { key: 'businessName', kind: 'text', label: 'Business name on the image', placeholder: 'Leave blank to use your brand kit', maxLength: 80 },
      // The switch that puts a merchant's shop on the picture. Its sentence is
      // built from the brand kit and whatever price was typed above, so it
      // sits after the price to read in order.
      { key: 'brand', kind: 'brand', label: 'Put my shop on it' },
    ],
    defaults: {
      mode: 'on_model',
      model: 'random',
      scene: 'random',
      pose: 'random',
      subject: 'auto',
      shadow: 'soft',
      aspect: '1:1',
      angleKeys: [],
      sizes: ['feed_square', 'story'],
    },
    assemble: (p) => {
      const out = { ...p };
      // 'random' is our word for "you choose"; the vendor's default is the field's absence.
      if (out.model === 'random') delete out.model;
      const keys = Array.isArray(out.angleKeys) ? (out.angleKeys as string[]).filter(Boolean) : [];
      if (keys.length) out.angleKeys = keys;
      else delete out.angleKeys;
      return out;
    },
  },
  {
    id: 'batch',
    label: 'A whole folder',
    short: 'Batch',
    icon: 'library',
    capability: 'BATCH',
    // It brings its own photos — a lot of them — so the canvas photo is not its source.
    needsSource: false,
    narrative: {
      queued: 'Waiting for a slot',
      routing: 'Starting your photos',
      waiting: 'Working through them',
      storing: 'Saving what came back',
      done: 'Done',
    },
    // Priced per photo, under whatever the chosen shot costs. The server works
    // the total out again from the photos it was actually given.
    costCodeFor: (v) => productModeCostCode(v.mode as string),
    quantityFor: (v) => countOf(v.sourceKeys),
    fields: [
      {
        key: 'sourceKeys',
        kind: 'photos',
        label: 'The photos',
        min: 2,
        max: BATCH_MAX,
        hint: `Up to ${BATCH_MAX} at a time. Add them from your library, or upload a folder's worth at once.`,
      },
      { key: 'mode', kind: 'modes', label: 'Do this to all of them' },
      {
        key: 'model',
        kind: 'select',
        label: 'Who wears them',
        options: [{ value: 'random', label: 'Any model' }],
        optionsFor: () => [{ value: 'random', label: 'Any model' }, ...MODEL_PRESETS.map((m) => ({ value: m, label: m[0]!.toUpperCase() + m.slice(1) }))],
        showIf: (v) => v.mode === 'on_model',
      },
      {
        key: 'scene',
        kind: 'select',
        label: 'Where',
        options: [{ value: 'random', label: 'Anywhere' }],
        optionsFor: () => MODEL_SCENES.map((s) => ({ value: s, label: s === 'random' ? 'Anywhere' : s })),
        showIf: (v) => v.mode === 'on_model',
      },
      {
        key: 'subject',
        kind: 'segment',
        label: 'What are they?',
        options: [
          { id: 'auto', label: 'Anything' },
          { id: 'food', label: 'Food' },
          { id: 'car', label: 'Vehicles' },
        ],
        showIf: (v) => v.mode === 'beautify',
      },
      {
        key: 'textKind',
        kind: 'segment',
        label: 'Which writing?',
        options: TEXT_KIND_KEYS.map((k) => ({ id: k, label: TEXT_KINDS[k].label, note: TEXT_KINDS[k].note })),
        showIf: (v) => v.mode === 'text_removal',
      },
      {
        // One instruction for the whole folder: "remove the hanger" across
        // forty hanger shots is the case this exists for.
        key: 'prompt',
        kind: 'text',
        label: 'What should be different in all of them?',
        placeholder: 'Remove the hanger',
        rows: 2,
        maxLength: 600,
        required: true,
        showIf: (v) => v.mode === 'edit',
      },
      {
        key: 'shadow',
        kind: 'segment',
        label: 'Shadow',
        options: [
          { id: 'soft', label: 'Soft' },
          { id: 'hard', label: 'Hard' },
          { id: 'floating', label: 'Floating' },
          { id: 'none', label: 'None' },
        ],
      },
      { key: 'aspect', kind: 'segment', label: 'Shape', options: ASPECTS.map((a) => ({ id: a, label: a })) },
      { key: 'sizes', kind: 'sizes', label: 'Export sizes' },
      // The one place this matters most: forty pictures either all carry the
      // shop's name or none of them do, and doing it here is the difference
      // between a catalogue and a folder.
      { key: 'brand', kind: 'brand', label: 'Put my shop on all of them' },
    ],
    defaults: {
      sourceKeys: [],
      mode: OFFERED_PRODUCT_MODES[0] ?? 'ghost_mannequin',
      model: 'random',
      scene: 'random',
      subject: 'auto',
      textKind: 'artificial',
      shadow: 'soft',
      aspect: '1:1',
      sizes: ['feed_square'],
    },
    // Every setting except the photo list belongs to the child, not the batch.
    localKeys: ['mode', 'model', 'scene', 'subject', 'shadow', 'aspect', 'sizes', 'brand', 'textKind', 'prompt'],
    assemble: (p) => {
      const sourceKeys = Array.isArray(p.sourceKeys) ? (p.sourceKeys as string[]).filter(Boolean) : [];
      const params: Record<string, unknown> = {
        mode: p.mode,
        subject: p.subject,
        shadow: p.shadow,
        aspect: p.aspect,
        sizes: p.sizes,
      };
      if (p.mode === 'on_model') {
        if (p.model && p.model !== 'random') params.model = p.model;
        if (p.scene) params.scene = p.scene;
      }
      if (p.mode === 'text_removal') params.textKind = p.textKind;
      if (p.mode === 'edit') params.prompt = p.prompt;
      // The badge choice rides down to every child, so the whole shoot agrees.
      if (p.brand) params.brand = p.brand;
      return { of: 'PRODUCT_SHOT', sourceKeys, params };
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
    if (f.kind === 'modes' && !productMode(String(v ?? ''))) return 'Pick what you need first.';
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

// ---------------------------------------------------------------------------
// FINDING A TOOL
//
// Fifteen icons in one strip is a wall. A merchant does not scan a toolbar
// looking for "Restyle" — they arrive knowing what they want ("put it on a
// model", "get the wrinkles out", "do all forty") and need the shortest path
// from that thought to that button.
//
// So: grouped by what comes OUT, searched by the words a merchant would use,
// and each one carries a sentence saying what it is for. The strip keeps only
// what is reachable right now; everything else lives one tap away.
// ---------------------------------------------------------------------------

export const TOOL_GROUPS = {
  photo: { label: 'Photos', note: 'Make one picture better, or make a new one from it.' },
  video: { label: 'Video', note: 'Reels, ads, and putting new words in someone’s mouth.' },
  sound: { label: 'Sound', note: 'A song for your Status, or a voice reading your script.' },
  words: { label: 'Words', note: 'The listing, the caption, the hashtags.' },
  bulk: { label: 'The whole shoot', note: 'Forty photos at once, not one at a time.' },
} as const;
export type ToolGroup = keyof typeof TOOL_GROUPS;

/**
 * What each tool is for, in a merchant's words, and the words they would
 * search with. `keywords` exists because nobody types "ghost mannequin" —
 * they type "mannequin", or "no model", or "hanger".
 */
export const TOOL_META: Record<ToolId, { group: ToolGroup; blurb: string; keywords: string }> = {
  shots: {
    group: 'photo',
    blurb: 'On a model, ghost mannequin, flat lay, pressed, studio.',
    keywords: 'model mannequin hanger clothes dress fashion wear worn flat lay iron wrinkle crease press studio beautify expand widen apparel okrika thrift',
  },
  scene: {
    group: 'photo',
    blurb: 'Your product somewhere else — a counter, a market, a studio.',
    keywords: 'scene background place setting staging lifestyle marble wood table',
  },
  background: { group: 'photo', blurb: 'Swap what is behind it, with a real shadow.', keywords: 'background backdrop behind replace plain white shadow' },
  cutout: {
    group: 'photo',
    blurb: 'The product on its own, on transparency or a colour.',
    keywords: 'cut out cutout remove background transparent png isolate',
  },
  enhance: { group: 'photo', blurb: 'Sharper and bigger, for print or a big screen.', keywords: 'enhance upscale sharpen bigger resolution quality blurry' },
  restyle: { group: 'photo', blurb: 'The same product, a different look.', keywords: 'restyle style look vibe recolour mood' },
  collage: {
    group: 'photo',
    blurb: 'Several photos in one — a set, a range, before and after.',
    keywords: 'collage grid several many multiple before after side by side montage',
  },
  flyer: {
    group: 'photo',
    blurb: 'A poster for an event or an offer, from your photo or from nothing.',
    keywords: 'flyer poster invite birthday party sale promo advert banner story',
  },
  video: {
    group: 'video',
    blurb: 'A reel from one photo, or a multi-shot ad with a presenter.',
    keywords: 'video reel ad advert clip motion animate presenter ugc tiktok shorts',
  },
  lipsync: { group: 'video', blurb: 'New words in the same mouth.', keywords: 'lipsync lip sync mouth dub speak talking' },
  translate: {
    group: 'video',
    blurb: 'The same video, spoken in another language.',
    keywords: 'translate dub language yoruba igbo hausa french spanish foreign',
  },
  music: { group: 'sound', blurb: 'A song about your shop, in a style you pick.', keywords: 'music song jingle beat afrobeats audio track sing' },
  voice: { group: 'sound', blurb: 'A script read aloud, in a voice you choose.', keywords: 'voice voiceover narration read speak audio announcer' },
  copy: { group: 'words', blurb: 'The description, the captions and the hashtags.', keywords: 'copy write listing description caption hashtag text words seo' },
  batch: {
    group: 'bulk',
    blurb: 'One edit, up to a hundred photos, one price per photo.',
    keywords: 'batch bulk many all folder catalogue forty everything at once',
  },
};

/**
 * Which group a finished generation belongs to, from its capability.
 *
 * The Results list needs this to filter, and it cannot go through TOOL_META:
 * a result knows the capability it used, not which tool asked for it, and two
 * tools can share one capability. Keyed off the thing the row actually holds.
 */
const GROUP_BY_CAPABILITY: Partial<Record<Capability, ToolGroup>> = {
  IMAGE_GENERATE: 'photo',
  IMAGE_EDIT: 'photo',
  BACKGROUND_REMOVE: 'photo',
  BACKGROUND_REPLACE: 'photo',
  RELIGHT: 'photo',
  UPSCALE: 'photo',
  COLLAGE: 'photo',
  PRODUCT_SHOT: 'photo',
  BATCH: 'bulk',
  IMAGE_TO_VIDEO: 'video',
  VIDEO_STITCH: 'video',
  DUB: 'video',
  LIPSYNC: 'video',
  MUSIC: 'sound',
  VOICEOVER: 'sound',
  TEXT_GENERATE: 'words',
};
/**
 * Takes a plain string: a result carries whatever capability the server
 * recorded, which may be one this build has never heard of. An unknown one
 * belongs to no group and is simply never filtered out.
 */
export const groupOfCapability = (capability: string): ToolGroup | undefined => GROUP_BY_CAPABILITY[capability as Capability];

/**
 * When a shot comes back wrong, what actually helps.
 *
 * "Try again" on a generation that could not keep the product is an offer to
 * fail the same way for the same money. The fidelity check refuses precisely
 * when the model returned something that is not the seller's item, and the
 * one thing known to fix that is more photos of it — the back of the bag,
 * the label, a close-up. A live run bore this out: the same request with two
 * reference images came back closer to the source than without.
 *
 * So: a low-quality failure on a tool that accepts angles is not offered a
 * retry, it is offered the fix.
 */
export function anglesWouldHelp(tool: Tool, values: Record<string, unknown>, failureKind: string | null | undefined): boolean {
  if (failureKind !== 'LOW_QUALITY') return false;
  const field = tool.fields.find((f) => f.kind === 'angles');
  if (!field || (field.showIf && !field.showIf(values))) return false;
  // Already at the ceiling: there are no more photos to ask for, and asking
  // anyway would be a dead end dressed as a remedy.
  const have = Array.isArray(values[field.key]) ? (values[field.key] as unknown[]).length : 0;
  return have < field.max;
}

/** Tools in a group, in the order the strip and the sheet show them. */
export const toolsIn = (group: ToolGroup): Tool[] => TOOLS.filter((t) => TOOL_META[t.id].group === group);

/**
 * Tools matching what someone typed.
 *
 * Matched against the name, the sentence and the keywords, so "wrinkle"
 * finds the merchant shots and "yoruba" finds Translate. An empty query
 * returns everything, which is what the sheet opens on.
 */
export function searchTools(query: string): Tool[] {
  const q = query.trim().toLowerCase();
  if (!q) return TOOLS;
  const words = q.split(/\s+/);
  return TOOLS.filter((t) => {
    const hay = `${t.label} ${t.short} ${TOOL_META[t.id].blurb} ${TOOL_META[t.id].keywords}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}
