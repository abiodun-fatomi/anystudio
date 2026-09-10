/**
 * The starter template catalogue.
 *
 * Every row is a setting a seller picks by looking at a rendered example of
 * it. The prompt is what the pipeline hands the model, so a template that
 * comes out wrong is fixed by editing a row from the staff console — this
 * file only decides what exists on day one.
 *
 * How the prompts are written, and why they read the way they do:
 *
 *   THE SETTING, NEVER THE PRODUCT.  The seller's item is the one thing the
 *   model must not invent. Every prompt describes ground, walls, light and
 *   depth and stops there; the fidelity loop in the image pipeline measures
 *   how much of the product survived, and a prompt that mentions the product
 *   is a prompt that invites it to be redrawn.
 *
 *   LIGHT IS NAMED.  "Soft daylight from the left", "a warm lamp just out of
 *   frame". Direction and quality of light are what make a composite read as
 *   one photograph instead of a cut-out on a picture, and they are the first
 *   thing a model drops when they are left implicit.
 *
 *   NO PEOPLE, NO TEXT, NO BRANDS.  Hands, faces, signage and logos are
 *   where generated scenes go visibly wrong, and a seller cannot fix them.
 *
 *   ROOM FOR THE PRODUCT.  Furniture scenes leave the floor deliberately
 *   empty, surfaces leave the middle clear. A beautiful room with nowhere to
 *   put a chair is a tile nobody taps twice.
 *
 * `sort` runs in tens inside each category so an operator can slot a new
 * template between two existing ones without renumbering the catalogue.
 *
 * `swatch` is the gradient drawn until the example render exists. It is not
 * decoration and not a guess: it is sampled from what the scene actually
 * looks like, so the tile is honest even before the photograph lands.
 */

import type { TemplateCategory } from '@anystudio/shared';

export interface TemplateSeed {
  code: string;
  name: string;
  note: string;
  category: TemplateCategory;
  kind: 'cut' | 'scene';
  prompt: string;
  swatch: { colors: [string] | [string, string]; ink: 'light' | 'dark' };
  keywords?: string;
  sort: number;
}

const t = (s: TemplateSeed): TemplateSeed => s;

export const TEMPLATES: TemplateSeed[] = [
  // ---------------------------------------------------------------------
  // Furniture — rooms with the floor left clear. The category that needs a
  // photograph most: nobody can tell a warm room from a cool one by reading
  // two colour chips, which is the whole reason this catalogue exists.
  // ---------------------------------------------------------------------
  t({
    code: 'furniture_living_warm',
    name: 'Warm living room',
    note: 'Oak floor, linen curtains, morning light.',
    category: 'furniture',
    kind: 'scene',
    prompt:
      'A warm minimal living room with a pale oak floor, off-white plaster walls and floor-length linen curtains half drawn. Soft morning daylight from a tall window on the left throws a long gentle shadow across the floor. The centre of the floor is completely empty. No people, no text, no signage.',
    swatch: { colors: ['#EFE4D6', '#D8C4AC'], ink: 'dark' },
    keywords: 'living room lounge sitting room parlour',
    sort: 10,
  }),
  t({
    code: 'furniture_living_lagos',
    name: 'Bright apartment',
    note: 'Terrazzo floor, tall louvres, a potted palm.',
    category: 'furniture',
    kind: 'scene',
    prompt:
      'A bright modern West African apartment interior with a speckled terrazzo floor, white walls and tall louvred windows. A potted palm stands in the far corner. Strong midday light comes through the louvres and lays soft bars of shadow across the empty floor. No people, no text, no signage.',
    swatch: { colors: ['#F2EFE9', '#D5D0C4'], ink: 'dark' },
    keywords: 'apartment lagos terrazzo louvre tropical',
    sort: 20,
  }),
  t({
    code: 'furniture_bedroom_calm',
    name: 'Calm bedroom corner',
    note: 'White walls, wide boards, low window light.',
    category: 'furniture',
    kind: 'scene',
    prompt:
      'A quiet bedroom corner with chalk-white walls and wide pale timber floorboards. A sheer curtain diffuses low afternoon light from the right, giving a soft-edged shadow. The corner of the floor is empty and unobstructed. No people, no text, no signage.',
    swatch: { colors: ['#F6F3EE', '#E2DBD1'], ink: 'dark' },
    keywords: 'bedroom corner calm neutral',
    sort: 30,
  }),
  t({
    code: 'furniture_dining_modern',
    name: 'Modern dining space',
    note: 'Polished concrete, one pendant lamp.',
    category: 'furniture',
    kind: 'scene',
    prompt:
      'A modern dining space with a polished concrete floor, a matte grey wall and a single black pendant lamp hanging just inside the top of the frame. Cool even light with a soft reflection on the concrete. The floor beneath the lamp is empty. No people, no text, no signage.',
    swatch: { colors: ['#D9D9D6', '#A9A9A6'], ink: 'dark' },
    keywords: 'dining concrete industrial modern',
    sort: 40,
  }),
  t({
    code: 'furniture_home_office',
    name: 'Home office nook',
    note: 'Bookshelf behind, warm lamp beside.',
    category: 'furniture',
    kind: 'scene',
    prompt:
      'A home office nook with a dark timber floor, a low bookshelf against a warm grey wall and a brass desk lamp glowing just out of frame to the right. Warm pooled light in the foreground falling off into shadow at the edges. The floor in front of the shelf is clear. No people, no text, no signage.',
    swatch: { colors: ['#E8DFD1', '#B79C7C'], ink: 'dark' },
    keywords: 'office study desk workspace bookshelf',
    sort: 50,
  }),
  t({
    code: 'furniture_patio_shade',
    name: 'Shaded patio',
    note: 'Terracotta tiles, greenery, dappled sun.',
    category: 'furniture',
    kind: 'scene',
    prompt:
      'A shaded outdoor patio with warm terracotta tiles, a low whitewashed wall and dense green foliage behind it. Dappled sunlight falls through leaves overhead and scatters across the empty tiled floor. No people, no text, no signage.',
    swatch: { colors: ['#E7C6A8', '#B98A63'], ink: 'dark' },
    keywords: 'patio outdoor veranda balcony garden terracotta',
    sort: 60,
  }),

  // ---------------------------------------------------------------------
  // Dresses
  // ---------------------------------------------------------------------
  t({
    code: 'dresses_boutique_rail',
    name: 'Boutique rail',
    note: 'A quiet shop wall, warm spotlights.',
    category: 'dresses',
    kind: 'scene',
    prompt:
      'The interior of a small upmarket boutique: a chalk-white wall, a slim brushed-brass clothing rail mounted at chest height and a pale wooden floor below. Warm directional spotlights from above with soft falloff. The rail is empty. No people, no text, no signage.',
    swatch: { colors: ['#F4EFE8', '#DCCFBE'], ink: 'dark' },
    keywords: 'boutique shop rail hanger store',
    sort: 10,
  }),
  t({
    code: 'dresses_studio_seamless',
    name: 'Studio seamless',
    note: 'A clean sweep, soft even light.',
    category: 'dresses',
    kind: 'scene',
    prompt:
      'A seamless photography studio backdrop in warm off-white curving from wall to floor with no visible corner. Large softbox light from the front left, a faint contact shadow at the base and a gentle gradient toward the top of the frame. No people, no text, no signage.',
    swatch: { colors: ['#FAF7F2', '#E4DED4'], ink: 'dark' },
    keywords: 'studio seamless plain backdrop sweep',
    sort: 20,
  }),
  t({
    code: 'dresses_street_wall',
    name: 'Painted street wall',
    note: 'Sunlit ochre wall, city pavement.',
    category: 'dresses',
    kind: 'scene',
    prompt:
      'A sunlit city pavement in front of a weathered ochre-painted wall with peeling texture. Late afternoon sun rakes across the wall from the right, casting a hard warm shadow. The pavement in the foreground is clear. No people, no text, no signage, no graffiti lettering.',
    swatch: { colors: ['#E8B878', '#C2884A'], ink: 'dark' },
    keywords: 'street outdoor wall city pavement editorial',
    sort: 30,
  }),
  t({
    code: 'dresses_garden_event',
    name: 'Garden party',
    note: 'Green lawn, string lights, golden hour.',
    category: 'dresses',
    kind: 'scene',
    prompt:
      'An outdoor garden at golden hour with a clipped green lawn, blurred flowering shrubs behind and warm string lights strung out of focus across the background. Low golden sunlight from behind creates a soft rim of light and a long shadow on the grass. No people, no text, no signage.',
    swatch: { colors: ['#E4D49A', '#9FA96B'], ink: 'dark' },
    keywords: 'garden party wedding owambe event outdoor golden hour',
    sort: 40,
  }),
  t({
    code: 'dresses_mirror_room',
    name: 'Mirror room',
    note: 'Full-length mirror, soft window light.',
    category: 'dresses',
    kind: 'scene',
    prompt:
      'A calm dressing room with a tall arched full-length mirror leaning against a warm ivory wall and a pale herringbone parquet floor. Soft diffuse daylight from a window out of frame on the left, gentle reflections in the glass. The floor in front of the mirror is clear. No people, no text, no signage.',
    swatch: { colors: ['#F1EAE0', '#D3C3B0'], ink: 'dark' },
    keywords: 'mirror dressing room fitting bridal',
    sort: 50,
  }),

  // ---------------------------------------------------------------------
  // Tops
  // ---------------------------------------------------------------------
  t({
    code: 'tops_flat_linen',
    name: 'Linen flat lay',
    note: 'Rumpled linen from directly above.',
    category: 'tops',
    kind: 'scene',
    prompt:
      'A top-down flat-lay surface of softly rumpled natural linen cloth in warm oatmeal, lit by broad soft daylight from the upper left with gentle shadows in the folds. The centre of the cloth is smooth and clear. No people, no text, no signage.',
    swatch: { colors: ['#EFE7D9', '#D3C6B0'], ink: 'dark' },
    keywords: 'flat lay linen fabric overhead top down',
    sort: 10,
  }),
  t({
    code: 'tops_studio_soft',
    name: 'Soft studio',
    note: 'A pale ground with one clean shadow.',
    category: 'tops',
    kind: 'scene',
    prompt:
      'A seamless pale greige studio backdrop with a smooth vertical gradient, one broad softbox from the front right and a single soft contact shadow at the base. No people, no text, no signage.',
    swatch: { colors: ['#EDE9E3', '#D2CCC2'], ink: 'dark' },
    keywords: 'studio plain clean simple',
    sort: 20,
  }),
  t({
    code: 'tops_wardrobe_rail',
    name: 'Wardrobe rail',
    note: 'Timber rail against a warm wall.',
    category: 'tops',
    kind: 'scene',
    prompt:
      'A simple wooden clothing rail mounted against a warm sand-coloured plaster wall, with a slim shadow beneath it. Soft daylight from the left. The rail is empty. No people, no text, no signage.',
    swatch: { colors: ['#EADFCE', '#C4AB8C'], ink: 'dark' },
    keywords: 'rail hanger wardrobe hang',
    sort: 30,
  }),
  t({
    code: 'tops_cafe_chair',
    name: 'Café chair',
    note: 'A bentwood chair by a sunny window.',
    category: 'tops',
    kind: 'scene',
    prompt:
      'A dark bentwood café chair beside a window with sheer curtains, standing on a worn parquet floor. Bright daylight from the window on the right, warm bounce on the floor. The seat of the chair is empty. No people, no text, no signage.',
    swatch: { colors: ['#E9DDC9', '#B08F65'], ink: 'dark' },
    keywords: 'cafe chair window casual lifestyle',
    sort: 40,
  }),

  // ---------------------------------------------------------------------
  // Bottoms
  // ---------------------------------------------------------------------
  t({
    code: 'bottoms_denim_flat',
    name: 'Denim flat lay',
    note: 'Washed canvas from above.',
    category: 'bottoms',
    kind: 'scene',
    prompt:
      'A top-down flat-lay surface of washed indigo canvas cloth with a subtle woven texture, lit evenly from above with a slight falloff at the corners. The centre is clear. No people, no text, no signage.',
    swatch: { colors: ['#4E5C71', '#2E3949'], ink: 'light' },
    keywords: 'denim jeans flat lay overhead',
    sort: 10,
  }),
  t({
    code: 'bottoms_studio_stone',
    name: 'Stone studio',
    note: 'Cool grey ground, crisp shadow.',
    category: 'bottoms',
    kind: 'scene',
    prompt:
      'A seamless cool stone-grey studio backdrop with a smooth gradient, one hard key light from the upper left giving a crisp defined shadow and a soft fill from the right. No people, no text, no signage.',
    swatch: { colors: ['#DCDCDA', '#ADADAB'], ink: 'dark' },
    keywords: 'studio grey stone plain',
    sort: 20,
  }),
  t({
    code: 'bottoms_wood_stool',
    name: 'Wooden stool',
    note: 'A low stool on a bare floor.',
    category: 'bottoms',
    kind: 'scene',
    prompt:
      'A low pale wooden stool on a bare polished concrete floor against a soft white wall. Diffuse daylight from the left with a gentle shadow pooling under the stool. The top of the stool is empty. No people, no text, no signage.',
    swatch: { colors: ['#E5DED2', '#B9AE9B'], ink: 'dark' },
    keywords: 'stool wood bench simple',
    sort: 30,
  }),

  // ---------------------------------------------------------------------
  // Outerwear
  // ---------------------------------------------------------------------
  t({
    code: 'outerwear_coat_hook',
    name: 'Coat hook',
    note: 'A brass hook on a panelled wall.',
    category: 'outerwear',
    kind: 'scene',
    prompt:
      'A single aged-brass coat hook mounted on a softly panelled wall painted deep sage, with a dark timber floor below. Warm directional light from the upper right, soft shadow to the left of the hook. The hook is empty. No people, no text, no signage.',
    swatch: { colors: ['#7E8C77', '#4E5A49'], ink: 'light' },
    keywords: 'hook coat hang hallway',
    sort: 10,
  }),
  t({
    code: 'outerwear_autumn_street',
    name: 'Cool street',
    note: 'Grey pavement, bare branches.',
    category: 'outerwear',
    kind: 'scene',
    prompt:
      'A quiet city street on an overcast day: damp grey pavement, a blurred row of bare trees and pale buildings far behind. Flat cool diffuse light with no hard shadows. The foreground pavement is clear. No people, no text, no signage.',
    swatch: { colors: ['#C9CCCE', '#8E9498'], ink: 'dark' },
    keywords: 'street autumn winter cold outdoor coat',
    sort: 20,
  }),
  t({
    code: 'outerwear_studio_charcoal',
    name: 'Charcoal studio',
    note: 'Dark ground so pale coats lift.',
    category: 'outerwear',
    kind: 'scene',
    prompt:
      'A seamless charcoal studio backdrop with a soft pool of light in the centre falling off to near-black at the edges, and a faint contact shadow at the base. No people, no text, no signage.',
    swatch: { colors: ['#3A3A3E', '#1B1B1E'], ink: 'light' },
    keywords: 'studio dark charcoal black moody',
    sort: 30,
  }),

  // ---------------------------------------------------------------------
  // Accessories — small items, so the surface is close and the depth shallow.
  // ---------------------------------------------------------------------
  t({
    code: 'accessories_velvet_tray',
    name: 'Velvet tray',
    note: 'Deep pile, jewel light.',
    category: 'accessories',
    kind: 'scene',
    prompt:
      'A shallow tray lined with deep midnight-blue velvet, photographed close with a shallow depth of field. A narrow warm key light from the upper left glances across the pile and falls away into shadow. The centre of the tray is empty. No people, no text, no signage.',
    swatch: { colors: ['#2B3A5C', '#141C2E'], ink: 'light' },
    keywords: 'velvet tray jewellery jewelry ring gold luxury',
    sort: 10,
  }),
  t({
    code: 'accessories_marble_ledge',
    name: 'Marble ledge',
    note: 'White marble, grey veining.',
    category: 'accessories',
    kind: 'scene',
    prompt:
      'A polished white marble ledge with fine grey veining against a soft blurred pale background. Bright soft daylight from the left, a crisp thin contact shadow and a faint reflection in the stone. The ledge is clear. No people, no text, no signage.',
    swatch: { colors: ['#F4F3F1', '#D8D6D2'], ink: 'dark' },
    keywords: 'marble stone ledge luxury clean',
    sort: 20,
  }),
  t({
    code: 'accessories_silk_fold',
    name: 'Silk folds',
    note: 'Soft champagne satin.',
    category: 'accessories',
    kind: 'scene',
    prompt:
      'Champagne-coloured silk fabric arranged in soft sweeping folds, filling the frame with a shallow depth of field. Gentle diffuse light from above catches the ridges of the folds and leaves the troughs in shadow. A smooth clear area in the middle. No people, no text, no signage.',
    swatch: { colors: ['#F0E2C8', '#CDB48A'], ink: 'dark' },
    keywords: 'silk satin fabric soft luxury drape',
    sort: 30,
  }),
  t({
    code: 'accessories_stone_riser',
    name: 'Stone riser',
    note: 'A raw plinth in warm light.',
    category: 'accessories',
    kind: 'scene',
    prompt:
      'A small raw travertine plinth standing on a sand-coloured surface against a warm neutral backdrop. Directional afternoon light from the right casts a defined shadow to the left. The top of the plinth is empty. No people, no text, no signage.',
    swatch: { colors: ['#E7D9C3', '#BFA684'], ink: 'dark' },
    keywords: 'plinth riser stone pedestal minimal',
    sort: 40,
  }),

  // ---------------------------------------------------------------------
  // Footwear
  // ---------------------------------------------------------------------
  t({
    code: 'footwear_concrete_step',
    name: 'Concrete step',
    note: 'A raw ledge, hard afternoon sun.',
    category: 'footwear',
    kind: 'scene',
    prompt:
      'A raw concrete step against a matching concrete wall, photographed straight on. Hard afternoon sunlight from the upper right throws a sharp diagonal shadow across the step. The surface of the step is clear. No people, no text, no signage.',
    swatch: { colors: ['#D6D3CD', '#9B978F'], ink: 'dark' },
    keywords: 'concrete step sneaker street hard light',
    sort: 10,
  }),
  t({
    code: 'footwear_studio_riser',
    name: 'Studio riser',
    note: 'A pale block on a clean sweep.',
    category: 'footwear',
    kind: 'scene',
    prompt:
      'A simple pale plaster block riser on a seamless warm white studio sweep. Broad soft light from the front left, a soft shadow trailing right. The top of the riser is empty. No people, no text, no signage.',
    swatch: { colors: ['#F5F1EA', '#DAD3C7'], ink: 'dark' },
    keywords: 'studio riser block plinth clean',
    sort: 20,
  }),
  t({
    code: 'footwear_sand',
    name: 'Sand',
    note: 'Fine rippled sand, low sun.',
    category: 'footwear',
    kind: 'scene',
    prompt:
      'Fine pale sand with gentle wind ripples filling the frame, photographed at a low angle. Warm low sun from the left picks out every ridge and casts long soft shadows. A smooth flat area in the middle. No people, no text, no signage, no footprints.',
    swatch: { colors: ['#EBD9B8', '#C4A878'], ink: 'dark' },
    keywords: 'sand beach sandals summer outdoor',
    sort: 30,
  }),
  t({
    code: 'footwear_court',
    name: 'Sports court',
    note: 'Painted lines, gym floor.',
    category: 'footwear',
    kind: 'scene',
    prompt:
      'A polished hardwood sports court floor with painted line markings running across it, photographed at a low angle with a dark blurred background. Bright overhead lighting reflecting in the varnish. A clear area of floor in the foreground. No people, no text, no signage, no lettering.',
    swatch: { colors: ['#D9A85F', '#8A6234'], ink: 'light' },
    keywords: 'court sport gym sneaker trainers basketball',
    sort: 40,
  }),

  // ---------------------------------------------------------------------
  // Bags
  // ---------------------------------------------------------------------
  t({
    code: 'bags_cafe_table',
    name: 'Café table',
    note: 'Marble top, blurred street behind.',
    category: 'bags',
    kind: 'scene',
    prompt:
      'A small round marble café table top photographed from just above eye level, with a warm blurred street scene far behind it. Soft daylight from the left, a gentle shadow on the stone. The table is clear. No people, no text, no signage.',
    swatch: { colors: ['#EDE7DC', '#C0B29B'], ink: 'dark' },
    keywords: 'cafe table street lifestyle handbag',
    sort: 10,
  }),
  t({
    code: 'bags_studio_plinth',
    name: 'Studio plinth',
    note: 'One block, one clean shadow.',
    category: 'bags',
    kind: 'scene',
    prompt:
      'A square matte plaster plinth in warm bone white on a seamless backdrop of the same tone. A single soft key light from the upper left gives a clean directional shadow. The top of the plinth is empty. No people, no text, no signage.',
    swatch: { colors: ['#F2EDE4', '#D5CCBC'], ink: 'dark' },
    keywords: 'plinth studio pedestal minimal luxury',
    sort: 20,
  }),
  t({
    code: 'bags_chair_back',
    name: 'Chair back',
    note: 'A wooden chair in a bright room.',
    category: 'bags',
    kind: 'scene',
    prompt:
      'The back of a pale wooden dining chair in a bright airy room with white walls and a light timber floor behind it. Soft window light from the right. The chair is empty. No people, no text, no signage.',
    swatch: { colors: ['#F1EBE0', '#CFC1AC'], ink: 'dark' },
    keywords: 'chair hang lifestyle room',
    sort: 30,
  }),

  // ---------------------------------------------------------------------
  // Beauty
  // ---------------------------------------------------------------------
  t({
    code: 'beauty_bathroom_shelf',
    name: 'Bathroom shelf',
    note: 'Pale tile, a glass shelf, clean light.',
    category: 'beauty',
    kind: 'scene',
    prompt:
      'A narrow glass shelf mounted on a wall of pale matte square tiles in a clean modern bathroom. Bright soft light from the front, a faint reflection in the glass and a soft shadow on the tile behind. The shelf is empty. No people, no text, no signage.',
    swatch: { colors: ['#EDF1F0', '#C6CFCE'], ink: 'dark' },
    keywords: 'bathroom shelf skincare tile clean bright',
    sort: 10,
  }),
  t({
    code: 'beauty_water_ripple',
    name: 'Still water',
    note: 'A shallow pool, soft ripples.',
    category: 'beauty',
    kind: 'scene',
    prompt:
      'A shallow pool of clear still water over pale stone, with soft concentric ripples and caustic light patterns on the bottom. Bright diffuse daylight from above. The centre of the water is calm and clear. No people, no text, no signage.',
    swatch: { colors: ['#DCEDF0', '#A7C9D2'], ink: 'dark' },
    keywords: 'water ripple fresh hydration skincare clean',
    sort: 20,
  }),
  t({
    code: 'beauty_stone_pedestal',
    name: 'Stone pedestal',
    note: 'Raw stone, warm shadow.',
    category: 'beauty',
    kind: 'scene',
    prompt:
      'A cylindrical raw limestone pedestal on a warm sand-toned surface against a softly graded backdrop in the same family. Warm directional light from the right giving a long soft shadow. The top of the pedestal is empty. No people, no text, no signage.',
    swatch: { colors: ['#EADCC6', '#C2A47F'], ink: 'dark' },
    keywords: 'pedestal stone natural organic minimal',
    sort: 30,
  }),
  t({
    code: 'beauty_petals',
    name: 'Petals',
    note: 'Scattered soft blooms.',
    category: 'beauty',
    kind: 'scene',
    prompt:
      'Soft pale pink and cream flower petals scattered loosely across a smooth blush surface, shot with a shallow depth of field so the outer petals blur. Gentle diffuse light from above. A clear smooth area in the centre. No people, no text, no signage.',
    swatch: { colors: ['#F7E3E1', '#DFB6B2'], ink: 'dark' },
    keywords: 'petals flowers floral soft feminine fragrance',
    sort: 40,
  }),

  // ---------------------------------------------------------------------
  // Food & drink
  // ---------------------------------------------------------------------
  t({
    code: 'food_wooden_table',
    name: 'Wooden table',
    note: 'Dark timber, warm side light.',
    category: 'food_drink',
    kind: 'scene',
    prompt:
      'A dark rustic timber table top with visible grain and a few honest scratches, against a deep blurred warm background. Warm directional light from the left with rich falloff into shadow on the right. The centre of the table is clear. No people, no text, no signage.',
    swatch: { colors: ['#6E4E33', '#3A281A'], ink: 'light' },
    keywords: 'wood table rustic restaurant warm',
    sort: 10,
  }),
  t({
    code: 'food_marble_kitchen',
    name: 'Kitchen counter',
    note: 'Marble worktop, bright daylight.',
    category: 'food_drink',
    kind: 'scene',
    prompt:
      'A white marble kitchen worktop with soft grey veining, a pale tiled splashback behind and blurred cabinetry at the edges. Bright clean daylight from a window to the left. The worktop is clear. No people, no text, no signage.',
    swatch: { colors: ['#F4F2EE', '#D6D2CA'], ink: 'dark' },
    keywords: 'kitchen marble counter bright clean home',
    sort: 20,
  }),
  t({
    code: 'food_banana_leaf',
    name: 'Banana leaf',
    note: 'Fresh green leaf, tropical light.',
    category: 'food_drink',
    kind: 'scene',
    prompt:
      'A large fresh banana leaf laid flat, filling the frame with its deep green ribs and glossy surface. Bright dappled tropical daylight from above with soft highlights along the ribs. A smooth clear area in the middle of the leaf. No people, no text, no signage.',
    swatch: { colors: ['#4E7A3C', '#28481F'], ink: 'light' },
    keywords: 'banana leaf tropical african jollof local green',
    sort: 30,
  }),
  t({
    code: 'food_cafe_counter',
    name: 'Café counter',
    note: 'Concrete bar, warm pendants.',
    category: 'food_drink',
    kind: 'scene',
    prompt:
      'A polished concrete café counter photographed straight on, with warm pendant lights blurred in the background and a hint of shelving behind. Warm ambient light with a soft reflection on the counter. The counter is clear. No people, no text, no signage.',
    swatch: { colors: ['#D8CFC3', '#9C8F7E'], ink: 'dark' },
    keywords: 'cafe counter coffee drink bar',
    sort: 40,
  }),

  // ---------------------------------------------------------------------
  // Electronics — a large share of the sellers here list phones and gadgets,
  // and every scene above is either fabric or food.
  // ---------------------------------------------------------------------
  t({
    code: 'electronics_desk_setup',
    name: 'Clean desk',
    note: 'Pale desk, cool morning light.',
    category: 'electronics',
    kind: 'scene',
    prompt:
      'A clean pale wooden desk top against a soft grey wall, with a blurred monitor edge far in the background. Cool even morning light from the left, a subtle soft shadow. The desk surface is clear. No people, no text, no signage, no logos.',
    swatch: { colors: ['#EDE9E2', '#C7C0B4'], ink: 'dark' },
    keywords: 'desk workspace tech gadget clean office',
    sort: 10,
  }),
  t({
    code: 'electronics_dark_glass',
    name: 'Dark glass',
    note: 'Black reflective ground, one edge light.',
    category: 'electronics',
    kind: 'scene',
    prompt:
      'A smooth black reflective glass surface fading into a near-black background, with a single narrow cool rim light raking across from the right and a clean mirror reflection below. The surface is clear. No people, no text, no signage, no logos.',
    swatch: { colors: ['#232428', '#0C0C0E'], ink: 'light' },
    keywords: 'black glass dark reflective premium tech phone',
    sort: 20,
  }),
  t({
    code: 'electronics_studio_grey',
    name: 'Grey studio',
    note: 'Neutral sweep, controlled shadow.',
    category: 'electronics',
    kind: 'scene',
    prompt:
      'A seamless neutral mid-grey studio sweep with a smooth gradient, two soft lights from either side and one controlled shadow directly beneath. No people, no text, no signage, no logos.',
    swatch: { colors: ['#DEDEDE', '#ADADAD'], ink: 'dark' },
    keywords: 'studio grey neutral plain product',
    sort: 30,
  }),

  // ---------------------------------------------------------------------
  // Everything else — the escape hatch. Deliberately generic, because a
  // seller who lands here has already failed to find their category and
  // needs something that works for anything.
  // ---------------------------------------------------------------------
  t({
    code: 'general_white_sweep',
    name: 'Plain white',
    note: 'What every marketplace asks for.',
    category: 'general',
    kind: 'cut',
    prompt: '',
    swatch: { colors: ['#FFFFFF'], ink: 'dark' },
    keywords: 'white plain marketplace jumia amazon listing',
    sort: 10,
  }),
  t({
    code: 'general_soft_shadow',
    name: 'Soft shadow',
    note: 'A neutral ground with one gentle shadow.',
    category: 'general',
    kind: 'scene',
    prompt:
      'A seamless warm off-white studio backdrop with a very soft vertical gradient, one broad diffused light from the front left and a single gentle contact shadow at the base. No people, no text, no signage.',
    swatch: { colors: ['#FAF8F4', '#E3DED4'], ink: 'dark' },
    keywords: 'neutral simple soft shadow anything',
    sort: 20,
  }),
  t({
    code: 'general_wood_surface',
    name: 'Wood surface',
    note: 'Warm oak, daylight from the side.',
    category: 'general',
    kind: 'scene',
    prompt:
      'A warm oak wooden surface with a fine visible grain, against a soft blurred neutral background. Diffuse daylight from the left with a soft shadow to the right. The surface is clear. No people, no text, no signage.',
    swatch: { colors: ['#E0C49B', '#B08B5C'], ink: 'dark' },
    keywords: 'wood oak table surface warm natural',
    sort: 30,
  }),
];

/** The params a tapped template fills in — the same shape a photo preset uses. */
export function templateParams(seed: TemplateSeed): Record<string, unknown> {
  // A cut CLEARS the prompt rather than ignoring it. Leaving a previous
  // pick's words in the field would make the panel show a description for a
  // shot that renders nothing, and the tool decides cut-or-scene by looking
  // at exactly that field.
  return seed.kind === 'cut' ? { background: '#FFFFFF', prompt: '' } : { prompt: seed.prompt };
}
