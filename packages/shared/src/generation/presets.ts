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
  /**
   * What a seller might type looking for this. Nobody searches "lifestyle" —
   * they search "jollof", "church", "owambe", "salon". Optional: the name and
   * the note are searched anyway, and most looks need nothing extra.
   */
  keywords?: string;
}

export const PRESET_GROUPS = {
  classic: { label: 'Classic', note: 'The product on nothing at all. Fast, and the product never changes.' },
  studio: { label: 'Studio', note: 'A clean coloured ground, like a small photo studio.' },
  surface: { label: 'On a surface', note: 'Wood, marble, stone — a real table under the product.' },
  lifestyle: { label: 'In a place', note: 'The product somewhere a customer would see it.' },
  home: { label: 'At home', note: 'A room a customer recognises, so they can picture owning it.' },
  food: { label: 'Food and drink', note: 'Plated, served, on a table someone would sit at.' },
  festive: { label: 'Occasions', note: 'Owambe, Christmas, Sallah, weddings — the seasons people shop for.' },
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

  // ---- Studio, continued: the rest of the coloured grounds ----
  {
    key: 'charcoal',
    name: 'Charcoal',
    note: 'Jewellery, watches, anything that catches light.',
    group: 'studio',
    kind: 'scene',
    swatch: { colors: ['#3A3740', '#232028'], ink: 'light' },
    params: { prompt: 'On a smooth charcoal-grey seamless backdrop, a single soft light from above and slightly left, a soft shadow beneath.' },
  },
  {
    key: 'terracotta',
    name: 'Terracotta',
    note: 'Warm skin tones, leather, clay.',
    group: 'studio',
    kind: 'scene',
    swatch: { colors: ['#D89476', '#B4664A'], ink: 'light' },
    params: { prompt: 'On a warm terracotta seamless backdrop, even diffused light, a short soft shadow directly under the product.' },
  },
  {
    key: 'deepgreen',
    name: 'Deep green',
    note: 'Skincare, herbs, anything natural.',
    group: 'studio',
    kind: 'scene',
    swatch: { colors: ['#3E5F49', '#26402F'], ink: 'light' },
    params: { prompt: 'On a deep forest-green seamless backdrop, soft directional light from the left, a gentle shadow to the right.' },
  },
  {
    key: 'gradientgold',
    name: 'Gold glow',
    note: 'Premium, gifting, end-of-year.',
    group: 'studio',
    kind: 'scene',
    swatch: { colors: ['#E8C77A', '#B98F3C'], ink: 'light' },
    params: { prompt: 'On a smooth warm gold gradient backdrop that fades darker towards the corners, a soft highlight behind the product.' },
    keywords: 'luxury premium gift christmas gold',
  },

  // ---- On a surface, continued ----
  {
    key: 'ankara',
    name: 'Ankara cloth',
    note: 'Fabric, jewellery, anything you sell by the yard.',
    group: 'surface',
    kind: 'scene',
    swatch: { colors: ['#D9743F', '#2E6E86'], ink: 'light' },
    params: {
      prompt:
        'On a folded length of colourful African wax-print fabric with bold geometric patterning, soft daylight, the fabric filling the frame behind and beneath the product.',
    },
    keywords: 'ankara wax print fabric african cloth material yard',
  },
  {
    key: 'raffia',
    name: 'Raffia mat',
    note: 'Craft, food, anything handmade.',
    group: 'surface',
    kind: 'scene',
    swatch: { colors: ['#DDCBA4', '#B39B6A'], ink: 'dark' },
    params: { prompt: 'On a woven raffia mat with visible natural texture, warm daylight from one side, a soft shadow across the weave.' },
    keywords: 'raffia woven straw mat basket handmade craft',
  },
  {
    key: 'slate',
    name: 'Dark slate',
    note: 'Food, spirits, anything you want to look serious.',
    group: 'surface',
    kind: 'scene',
    swatch: { colors: ['#4B4E52', '#2C2E31'], ink: 'light' },
    params: { prompt: 'On a dark slate slab with a faint matte texture, moody side light, deep shadow falling away from the product.' },
  },
  {
    key: 'glassshelf',
    name: 'Glass shelf',
    note: 'Perfume, phones, electronics.',
    group: 'surface',
    kind: 'scene',
    swatch: { colors: ['#DCE6EA', '#9FB3BC'], ink: 'dark' },
    params: { prompt: 'On a clear glass shelf with a soft reflection beneath the product, cool even light, a pale grey wall softly out of focus behind.' },
    keywords: 'glass reflection perfume phone electronics gadget',
  },

  // ---- In a place, continued ----
  {
    key: 'boutique',
    name: 'Boutique rail',
    note: 'Clothes, bags, shoes — a small shop that looks well kept.',
    group: 'lifestyle',
    kind: 'scene',
    swatch: { colors: ['#E3D9CE', '#B9A894'], ink: 'dark' },
    params: { prompt: 'In a tidy boutique with a clothing rail and warm shop lighting softly blurred behind, the product in clear focus in the foreground.' },
    keywords: 'boutique shop store rail clothes fashion',
  },
  {
    key: 'salon',
    name: 'Salon counter',
    note: 'Hair, wigs, beauty, skincare.',
    group: 'lifestyle',
    kind: 'scene',
    swatch: { colors: ['#F0DDE4', '#C79AAC'], ink: 'dark' },
    params: { prompt: 'On a clean salon counter with a softly blurred mirror and warm bulb lighting behind, bright even light on the product.' },
    keywords: 'salon hair wig beauty skincare makeup barber',
  },
  {
    key: 'counter',
    name: 'Shop counter',
    note: 'Phones, accessories, anything sold over a counter.',
    group: 'lifestyle',
    kind: 'scene',
    swatch: { colors: ['#CFC6BA', '#8E8377'], ink: 'dark' },
    params: { prompt: 'On a clean shop counter with shelves softly out of focus behind, bright neutral indoor light, the product placed front and centre.' },
    keywords: 'counter shop kiosk phone accessories electronics',
  },
  {
    key: 'street',
    name: 'Street stall',
    note: 'Busy, real, everyday trade.',
    group: 'lifestyle',
    kind: 'scene',
    swatch: { colors: ['#C99A5B', '#8A6234'], ink: 'light' },
    params: { prompt: 'At a busy street stall with the market softly blurred behind, late-afternoon sun, the product sharp in the foreground.' },
    keywords: 'street market stall roadside trade lagos',
  },

  // ---- At home ----
  {
    key: 'livingroom',
    name: 'Living room',
    note: 'Furniture, decor, electronics.',
    group: 'home',
    kind: 'scene',
    swatch: { colors: ['#E6DED2', '#B2A695'], ink: 'dark' },
    params: { prompt: 'In a bright, tidy living room with a sofa and a plant softly out of focus behind, warm daylight through a window.' },
    keywords: 'living room sofa lounge sitting furniture home decor',
  },
  {
    key: 'kitchen',
    name: 'Kitchen top',
    note: 'Food, drinks, appliances, cleaning.',
    group: 'home',
    kind: 'scene',
    swatch: { colors: ['#E8E4DC', '#B6B0A4'], ink: 'dark' },
    params: { prompt: 'On a clean kitchen worktop with cupboards softly blurred behind, bright morning daylight from a window to the left.' },
    keywords: 'kitchen worktop counter cooking appliance home',
  },
  {
    key: 'bedside',
    name: 'Bedside',
    note: 'Skincare, candles, small comforts.',
    group: 'home',
    kind: 'scene',
    swatch: { colors: ['#E9DFD8', '#BCA898'], ink: 'dark' },
    params: { prompt: 'On a bedside table with soft bedding out of focus behind, warm low lamplight, a calm and quiet mood.' },
    keywords: 'bedside bedroom night lamp skincare candle',
  },
  {
    key: 'bathroom',
    name: 'Bathroom shelf',
    note: 'Soap, creams, anything for washing.',
    group: 'home',
    kind: 'scene',
    swatch: { colors: ['#DDE7E6', '#A5B8B6'], ink: 'dark' },
    params: { prompt: 'On a clean bathroom shelf with pale tiles softly out of focus behind, bright even daylight, a fresh clean feel.' },
    keywords: 'bathroom soap shower cream wash toiletries',
  },

  // ---- Food and drink ----
  {
    key: 'plated',
    name: 'On a plate',
    note: 'Cooked food, ready to eat.',
    group: 'food',
    kind: 'scene',
    swatch: { colors: ['#F2EDE4', '#C9BFAE'], ink: 'dark' },
    params: { prompt: 'Plated on a simple white ceramic plate on a wooden table, natural window light from the side, steam and freshness visible.' },
    keywords: 'plate food meal cooked rice jollof dish restaurant',
  },
  {
    key: 'servingboard',
    name: 'Serving board',
    note: 'Small chops, pastries, anything shared.',
    group: 'food',
    kind: 'scene',
    swatch: { colors: ['#D8B98E', '#A88253'], ink: 'light' },
    params: { prompt: 'Arranged on a wooden serving board on a table, warm daylight from above and behind, a few crumbs for realism.' },
    keywords: 'small chops pastry snack board sharing platter puff',
  },
  {
    key: 'drink',
    name: 'Cold drink',
    note: 'Bottles, juices, anything served chilled.',
    group: 'food',
    kind: 'scene',
    swatch: { colors: ['#CFE3EE', '#87A9BD'], ink: 'dark' },
    params: { prompt: 'On a cool surface with condensation beading on the product, bright backlight catching the drops, a fresh chilled feel.' },
    keywords: 'drink bottle juice cold chilled zobo smoothie water',
  },
  {
    key: 'produce',
    name: 'Fresh produce',
    note: 'Raw food, grains, spices.',
    group: 'food',
    kind: 'scene',
    swatch: { colors: ['#C8D6A0', '#8CA45E'], ink: 'dark' },
    params: { prompt: 'Among fresh produce on a market table — greens and grains softly out of focus behind — bright daylight, the product sharp in front.' },
    keywords: 'produce vegetable grain spice pepper market fresh raw',
  },

  // ---- Occasions ----
  {
    key: 'owambe',
    name: 'Owambe',
    note: 'Aso-ebi, gele, wedding season.',
    group: 'festive',
    kind: 'scene',
    swatch: { colors: ['#E0B24C', '#9C6E1F'], ink: 'light' },
    params: {
      prompt:
        'At a celebration in warm gold light with softly blurred decorated tables and guests far behind, the product sharp and well lit in the foreground.',
    },
    keywords: 'owambe wedding aso ebi gele party celebration naming',
  },
  {
    key: 'christmas',
    name: 'Christmas',
    note: 'December gifting.',
    group: 'festive',
    kind: 'scene',
    swatch: { colors: ['#C7413B', '#7E2320'], ink: 'light' },
    params: { prompt: 'On a festive table with warm fairy lights softly out of focus behind, deep red and gold tones, an evening gifting mood.' },
    keywords: 'christmas xmas december gift festive holiday',
  },
  {
    key: 'sallah',
    name: 'Sallah',
    note: 'Eid, family gathering, gifting.',
    group: 'festive',
    kind: 'scene',
    swatch: { colors: ['#8FBFA8', '#3F7E63'], ink: 'light' },
    params: { prompt: 'On a decorated table set for a family gathering, soft green and gold tones, warm afternoon light, a generous unhurried mood.' },
    keywords: 'sallah eid ramadan muslim gathering gift family',
  },
  {
    key: 'giftbox',
    name: 'Gift wrapped',
    note: 'Anything bought for someone else.',
    group: 'festive',
    kind: 'scene',
    swatch: { colors: ['#E8D3DC', '#B98FA0'], ink: 'dark' },
    params: { prompt: 'Beside an open gift box with ribbon and tissue paper, soft even light, the product clearly the thing being given.' },
    keywords: 'gift box present wrap ribbon birthday anniversary',
  },
  {
    key: 'backtoschool',
    name: 'Back to school',
    note: 'Bags, books, uniforms, September.',
    group: 'festive',
    kind: 'scene',
    swatch: { colors: ['#B9C9E6', '#6D82AE'], ink: 'dark' },
    params: { prompt: 'On a school desk with books and stationery softly out of focus behind, bright clean daylight, a tidy and organised feel.' },
    keywords: 'school uniform bag book student september resumption',
  },
];

export const preset = (key: string | null | undefined): PhotoPreset | undefined => PHOTO_PRESETS.find((p) => p.key === key);

/** The presets of one group, in catalogue order. */
export const presetsIn = (group: PresetGroup): PhotoPreset[] => PHOTO_PRESETS.filter((p) => p.group === group);

/**
 * How many looks the panel shows before the door to the rest.
 *
 * Forty-two tiles in a panel is the tool-strip mistake again: a wall, not a
 * menu. The first few of each group are the ones most people tap, and the
 * rest are one press away — searchable, because "owambe" or "jollof" is how
 * a seller would ask for them and no amount of scrolling is faster than
 * typing it.
 */
export const PRESETS_INLINE = 4;

/**
 * Looks matching what someone typed.
 *
 * Matched against the name, the sentence and the search words, so "jollof"
 * finds the plate, "wig" finds the salon counter and "yard" finds the ankara
 * cloth. An empty query is everything, which is what the sheet opens on.
 */
export function searchPresets(query: string): PhotoPreset[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...PHOTO_PRESETS];
  const words = q.split(/\s+/);
  return PHOTO_PRESETS.filter((p) => {
    const hay = `${p.name} ${p.note} ${p.keywords ?? ''} ${PRESET_GROUPS[p.group].label}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/**
 * A `cut` preset is a different capability from a `scene` one — it flattens a
 * cut-out onto a colour instead of asking a model for a setting. The studio
 * sends whichever the tapped preset names, which is why one tool can offer
 * both without the seller ever learning the difference.
 */
export const presetCapability = (p: PhotoPreset): 'BACKGROUND_REMOVE' | 'IMAGE_EDIT' => (p.kind === 'cut' ? 'BACKGROUND_REMOVE' : 'IMAGE_EDIT');
