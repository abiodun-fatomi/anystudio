/**
 * Looks you pick by looking.
 *
 * The studio used to open on a blank box that asked "Where should the product
 * be?". That is art direction homework, and a seller with a phone and forty
 * items to post does not want homework — they want to see four pictures and
 * tap the one they like. Every preset here is a saved answer to that
 * question: a name a seller would use, a swatch that shows roughly what comes
 * out, and the params the tool fills in when it is tapped.
 *
 * Two kinds, and the difference matters for cost and for trust:
 *
 *   CUT      the product is cut out and dropped on a flat colour. Nothing is
 *            invented, so the product cannot drift, it costs 2 credits and it
 *            comes back in seconds. This is what most listings actually need.
 *   SCENE    a described setting. Costs more, takes longer, and the fidelity
 *            loop watches the product because a model is redrawing the frame.
 *
 * A preset is not a lock: tapping one fills the fields, and the seller can
 * still edit every word afterwards. That is the whole point — it replaces the
 * empty page with a good first draft, and nothing else.
 */

/** How a preset's tile is drawn before we have a render of the seller's own product on it. */
export interface PresetSwatch {
  /** A flat colour, or two for a soft gradient — the ground the product sits on. */
  colors: [string] | [string, string];
  /** A checkerboard tile instead of a colour, for the transparent cut-out. */
  transparent?: boolean;
  /** Light or dark, so the tile's own label stays readable. */
  ink: 'light' | 'dark';
}

export interface PhotoPreset {
  key: string;
  /** What a seller would call it. Never a capability name. */
  name: string;
  /** One line, shown under the tile on wide screens and as the title everywhere. */
  note: string;
  group: PresetGroup;
  kind: 'cut' | 'scene';
  swatch: PresetSwatch;
  /**
   * The params this preset fills in. For `cut` presets that is a background
   * colour; for `scene` presets, the prompt. Merged over whatever the seller
   * already set, so a price or a business name they typed is kept.
   */
  params: Record<string, unknown>;
}

export const PRESET_GROUPS = {
  classic: { label: 'Classic', note: 'The product on nothing at all. Fast, and the product never changes.' },
  studio: { label: 'Studio', note: 'A clean coloured ground, like a small photo studio.' },
  surface: { label: 'On a surface', note: 'Wood, marble, stone — a real table under the product.' },
  lifestyle: { label: 'In a place', note: 'The product somewhere a customer would see it.' },
} as const;
export type PresetGroup = keyof typeof PRESET_GROUPS;

/**
 * The catalogue. Ordered within each group from most-used to least, because
 * the first tile in a row is the one most people tap.
 *
 * The `cut` presets route to BACKGROUND_REMOVE, which flattens onto a colour
 * without a model in the loop. The `scene` presets are IMAGE_EDIT prompts,
 * written the way the edit models want them — the setting and the light, never
 * the product, which is held constant by the pipeline.
 */
export const PHOTO_PRESETS: readonly PhotoPreset[] = [
  // ---- Classic: no model, no drift, 2 credits ----
  {
    key: 'white',
    name: 'Plain white',
    note: 'What every marketplace asks for.',
    group: 'classic',
    kind: 'cut',
    swatch: { colors: ['#FFFFFF'], ink: 'dark' },
    params: { background: '#FFFFFF' },
  },
  {
    key: 'transparent',
    name: 'No background',
    note: 'A PNG you can drop into anything.',
    group: 'classic',
    kind: 'cut',
    swatch: { colors: ['#FFFFFF'], transparent: true, ink: 'dark' },
    params: { background: 'transparent' },
  },
  {
    key: 'black',
    name: 'Deep black',
    note: 'Makes gold, glass and jewellery lift.',
    group: 'classic',
    kind: 'cut',
    swatch: { colors: ['#101014'], ink: 'light' },
    params: { background: '#101014' },
  },
  {
    key: 'cream',
    name: 'Soft cream',
    note: 'Warmer than white; kind to fabric.',
    group: 'classic',
    kind: 'cut',
    swatch: { colors: ['#F6F1EA'], ink: 'dark' },
    params: { background: '#F6F1EA' },
  },

  // ---- Studio: a coloured ground with light, still cheap to trust ----
  {
    key: 'studio_blush',
    name: 'Blush',
    note: 'Beauty, skincare, soft goods.',
    group: 'studio',
    kind: 'scene',
    swatch: { colors: ['#F7E4DC', '#EFCFC2'], ink: 'dark' },
    params: { prompt: 'A seamless blush-pink studio backdrop with a soft gradient, gentle top light and a faint contact shadow under the product.' },
  },
  {
    key: 'studio_sage',
    name: 'Sage',
    note: 'Natural, herbal, handmade.',
    group: 'studio',
    kind: 'scene',
    swatch: { colors: ['#E3EBDD', '#CFDCC6'], ink: 'dark' },
    params: { prompt: 'A seamless sage-green studio backdrop with a soft gradient, even diffused light and a faint contact shadow under the product.' },
  },
  {
    key: 'studio_sky',
    name: 'Sky',
    note: 'Cool, clean, electronics and plastics.',
    group: 'studio',
    kind: 'scene',
    swatch: { colors: ['#DFEAF6', '#C6D9EE'], ink: 'dark' },
    params: { prompt: 'A seamless pale-blue studio backdrop with a soft gradient, crisp even light and a faint contact shadow under the product.' },
  },
  {
    key: 'studio_sand',
    name: 'Sand',
    note: 'Warm neutral that suits almost anything.',
    group: 'studio',
    kind: 'scene',
    swatch: { colors: ['#EFE5D6', '#DFCFB6'], ink: 'dark' },
    params: { prompt: 'A seamless warm sand-coloured studio backdrop with a soft gradient, warm side light and a faint contact shadow under the product.' },
  },
  {
    key: 'studio_spotlight',
    name: 'Spotlight',
    note: 'One bright pool of light, dark around it.',
    group: 'studio',
    kind: 'scene',
    swatch: { colors: ['#3A3340', '#14111A'], ink: 'light' },
    params: {
      prompt: 'A dark studio with a single overhead spotlight pooling on the surface around the product, deep falloff to black at the edges of the frame.',
    },
  },

  // ---- On a surface: a real table under it ----
  {
    key: 'marble',
    name: 'White marble',
    note: 'Reads expensive. Good for beauty and food.',
    group: 'surface',
    kind: 'scene',
    swatch: { colors: ['#F3F2EF', '#DFDDD6'], ink: 'dark' },
    params: { prompt: 'On a white marble surface with grey veining, soft daylight from the left, a gentle shadow to the right of the product.' },
  },
  {
    key: 'wood',
    name: 'Warm wood',
    note: 'Home, kitchen, craft.',
    group: 'surface',
    kind: 'scene',
    swatch: { colors: ['#C89B6A', '#9A6E42'], ink: 'light' },
    params: { prompt: 'On a warm wooden table with visible grain, morning window light from one side and a soft natural shadow.' },
  },
  {
    key: 'linen',
    name: 'Linen cloth',
    note: 'Fabric, jewellery, anything small.',
    group: 'surface',
    kind: 'scene',
    swatch: { colors: ['#EDE7DB', '#D8CFBE'], ink: 'dark' },
    params: { prompt: 'On rumpled natural linen cloth with soft folds, diffused overhead daylight, shallow depth of field.' },
  },
  {
    key: 'concrete',
    name: 'Concrete',
    note: 'Streetwear, tools, hard goods.',
    group: 'surface',
    kind: 'scene',
    swatch: { colors: ['#B9B7B3', '#8A8884'], ink: 'light' },
    params: { prompt: 'On a raw grey concrete surface with subtle texture, hard directional light and a crisp shadow.' },
  },

  // ---- In a place: the product in a life ----
  {
    key: 'market',
    name: 'Market stall',
    note: 'Where your customer already shops.',
    group: 'lifestyle',
    kind: 'scene',
    swatch: { colors: ['#D9A441', '#A9702A'], ink: 'light' },
    params: {
      prompt: 'On a busy West African market stall in warm late-afternoon sun, colourful fabric and produce blurred behind, shot handheld on a phone.',
    },
  },
  {
    key: 'window',
    name: 'By a window',
    note: 'Bright, homely, easy to trust.',
    group: 'lifestyle',
    kind: 'scene',
    swatch: { colors: ['#F1EDE4', '#CFC6B4'], ink: 'dark' },
    params: { prompt: 'On a windowsill in bright morning light with a soft-focus room behind, long natural shadows across the surface.' },
  },
  {
    key: 'outdoor',
    name: 'Outside',
    note: 'Daylight, greenery, open air.',
    group: 'lifestyle',
    kind: 'scene',
    swatch: { colors: ['#BFD3A8', '#7E9A62'], ink: 'light' },
    params: { prompt: 'Outdoors on a low wall with green foliage softly blurred behind, golden-hour sunlight and dappled shadow.' },
  },
  {
    key: 'party',
    name: 'Party table',
    note: 'Gifting, celebration, owambe season.',
    group: 'lifestyle',
    kind: 'scene',
    swatch: { colors: ['#E7C9DE', '#B5799F'], ink: 'light' },
    params: { prompt: 'On a decorated celebration table with soft bokeh lights behind, warm evening light, a festive but uncluttered setting.' },
  },
];

export const preset = (key: string | null | undefined): PhotoPreset | undefined => PHOTO_PRESETS.find((p) => p.key === key);

/** The presets of one group, in catalogue order. */
export const presetsIn = (group: PresetGroup): PhotoPreset[] => PHOTO_PRESETS.filter((p) => p.group === group);

/**
 * A `cut` preset is a different capability from a `scene` one — it flattens a
 * cut-out onto a colour instead of asking a model for a setting. The studio
 * sends whichever the tapped preset names, which is why one tool can offer
 * both without the seller ever learning the difference.
 */
export const presetCapability = (p: PhotoPreset): 'BACKGROUND_REMOVE' | 'IMAGE_EDIT' => (p.kind === 'cut' ? 'BACKGROUND_REMOVE' : 'IMAGE_EDIT');
