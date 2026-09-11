/**
 * The seam where a customer's photo can go missing.
 *
 * A tool definition says which fields the panel collects; a capability schema
 * says which fields the API accepts. Zod strips anything it does not know,
 * silently and by design — so a field the panel collects and the schema has
 * never heard of is not an error anywhere. It is just gone.
 *
 * That is not hypothetical. The flyer tool routed to IMAGE_GENERATE, which
 * makes a picture from words alone and has no `sourceKey`. The studio
 * attached the canvas photo anyway, the parser dropped it without a word, and
 * a seller who uploaded a photo of her own daughter was handed flyers of two
 * other children. Nothing threw. Nothing was logged. The result card even
 * showed her photo as the source.
 *
 * These tests walk every tool through every combination of its own switches
 * and assert three things a customer can feel:
 *
 *   1. a tool that leans on the canvas photo routes to a capability that can
 *      actually take one
 *   2. nothing the panel collects is dropped on the floor between the button
 *      and the API
 *   3. when the button is pressable, the request it sends is valid
 *
 * The canary at the bottom is the one that matters most: it proves this file
 * still fails when it should.
 */
import { describe, expect, it } from 'vitest';
import { priceExample } from '@anystudio/shared';

describe('flyer quality routing', () => {
  it.each(['new', 'photo'])('tags the %s path as design rather than photographic generation', (useSource) => {
    const flyer = toolById('flyer')!;
    expect(flyer.assemble!({ ...flyer.defaults, useSource, prompt: 'A birthday flyer' }).useCase).toBe('design');
  });
});
import {
  CAPABILITIES,
  PRODUCT_REFERENCE_ANGLES,
  REEL_BRIEF,
  acceptsSourceKey,
  capabilityFields,
  namesAVendor,
  parseCapabilityParams,
  type Capability,
} from '@anystudio/shared';
import {
  TOOLS,
  TOOL_GROUPS,
  TOOL_META,
  anglesWouldHelp,
  coerceParams,
  groupOfCapability,
  isCutChoice,
  missingFor,
  restoreToolValues,
  searchTools,
  toolById,
  toolsIn,
  type Tool,
  type ToolGroup,
  type ToolId,
} from './tools';

/** Whether the tool brings its own source rather than using the canvas photo. */
const ownsSource = (t: Tool): boolean => t.fields.some((f) => (f.kind === 'file' && f.key === 'sourceKey') || f.kind === 'photos');

describe('Restyle preserves the whole photo', () => {
  it('Enhance corrects the photo without retaining legacy enlargement settings', () => {
    const tool = toolById('enhance')!;
    expect(tool.capability).toBe('IMAGE_EDIT');
    const params = coerceParams(tool, { sourceKey: 'ws/photo.jpg', factor: 4, sizes: ['story'] });
    expect(params).toMatchObject({ restyle: 'enhance', sizes: [], sourceKey: 'ws/photo.jpg' });
    expect(params).not.toHaveProperty('factor');
    expect(parseCapabilityParams(tool.capability, params).ok).toBe(true);
    expect(toolById('upscale')!.capability).toBe('UPSCALE');
  });
  it('forces a non-generative treatment even when repeating legacy settings', () => {
    const tool = toolById('restyle')!;
    const params = coerceParams(tool, { sourceKey: 'ws/photo.jpg', prompt: 'Reinvent the room', preserveProduct: true, aspect: '1:1' });
    const parsed = parseCapabilityParams('IMAGE_EDIT', params);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('Restyle request is invalid');
    expect(parsed.params).toMatchObject({ restyle: 'natural', sourceKey: 'ws/photo.jpg', preserveProduct: false });
    expect(params.prompt).not.toContain('Reinvent');
    expect(tool.fields.some((f) => f.key === 'prompt')).toBe(false);
  });
});

describe('video presenter selection', () => {
  const video = toolById('video')!;
  it('restores a narrated request for editing or repeating without losing speech', () => {
    const saved = { shots: 4, format: 'price_drop', audio: true, narration: { script: 'Our bottle is ready.', voiceId: 'voice-1' } };
    const restored = restoreToolValues(video, saved);
    expect(missingFor(video, restored)).toBeNull();
    expect(coerceParams(video, restored).narration).toEqual(saved.narration);
    expect(restoreToolValues(video, { audio: false }).narrationEnabled).toBe(false);
  });
  it('sends narration and clip sound together without a presenter', () => {
    const values = { ...video.defaults, narrationVoiceId: 'voice-1', narrationScript: 'Our bottle is ready.' };
    expect(missingFor(video, values)).toBeNull();
    const params = coerceParams(video, values);
    expect(params.audio).toBe(true);
    expect(params.narration).toEqual({ script: values.narrationScript, voiceId: 'voice-1' });
    expect(params).not.toHaveProperty('presenter');
    expect(parseCapabilityParams('IMAGE_TO_VIDEO', { ...params, sourceKey: 'ws/photo.jpg' }).ok).toBe(true);
  });
  it('requires a face only when With presenter is selected', () => {
    const values = { ...video.defaults, format: 'ugc', shots: 4, presentation: 'presenter' };
    expect(missingFor(video, values)).toBe('Pick who talks to camera.');
    expect(missingFor(video, { ...values, presenterKind: 'none' })).toBe('Choose a presenter for your UGC ad.');
    const params = coerceParams(video, { ...values, presenterKey: 'daphne', presenterVoiceId: 'voice-1' });
    expect(params.presenter).toMatchObject({ kind: 'stock', key: 'daphne' });
    expect(parseCapabilityParams('IMAGE_TO_VIDEO', { ...params, sourceKey: 'ws/bottle.jpg' }).ok).toBe(true);
  });
  it('allows product-only UGC with narration and clears stale presenter settings', () => {
    const values = {
      ...video.defaults,
      format: 'ugc',
      shots: 4,
      presentation: 'product',
      presenterKind: 'photo',
      presenterPhotoKey: 'ws/me.jpg',
      presenterConsent: true,
      presenter: { kind: 'photo', photoKey: 'ws/me.jpg', consent: true },
      narrationScript: 'Take a closer look.',
    };
    expect(missingFor(video, { ...values, narrationVoiceId: 'voice-1' })).toBeNull();
    const params = coerceParams(video, { ...values, narrationVoiceId: 'voice-1' });
    expect(params).not.toHaveProperty('presentation');
    expect(params).not.toHaveProperty('presenter');
    expect(params).not.toHaveProperty('presenterPhotoKey');
    expect(params.narration).toMatchObject({ script: 'Take a closer look.' });
    expect(parseCapabilityParams('IMAGE_TO_VIDEO', { ...params, sourceKey: 'ws/product.jpg' }).ok).toBe(true);
  });
  it('restores existing presenter requests and keeps consent mandatory', () => {
    const restored = restoreToolValues(video, { shots: 4, format: 'ugc', presenter: { kind: 'photo', photoKey: 'ws/me.jpg', consent: true } });
    expect(restored.presentation).toBe('presenter');
    expect(coerceParams(video, restored).presenter).toMatchObject({ kind: 'photo', consent: true });
    expect(missingFor(video, { ...restored, presenterConsent: false })).not.toBeNull();
    expect(restoreToolValues(video, { format: 'ugc', shots: 4 }).presentation).toBe('product');
  });
  it('explains the minimum length for a visible presenter', () => {
    expect(missingFor(video, { ...video.defaults, format: 'ugc', presentation: 'presenter' })).toBe('Choose 15 seconds or longer for a visible presenter.');
  });
  it.each([
    { shots: 1, format: 'ugc' },
    { shots: 4, format: 'reveal' },
  ])('removes stale presenters when switching to %j', (selection) => {
    const values = { ...video.defaults, ...selection, narrationEnabled: false, presenterKey: 'daphne', presenter: { kind: 'stock', key: 'daphne' } };
    expect(missingFor(video, values)).toBeNull();
    expect(coerceParams(video, values)).not.toHaveProperty('presenter');
  });
});

/**
 * Every setting of every switch. Conditional bugs live in the combinations —
 * the flyer was only broken on one branch of one control.
 */
function combos(t: Tool): Record<string, unknown>[] {
  let out: Record<string, unknown>[] = [{ ...t.defaults }];
  for (const f of t.fields) {
    const options = f.kind === 'segment' ? f.options.map((o) => o.id) : f.kind === 'select' ? f.options.map((o) => o.value) : [];
    if (options.length === 0 || options.length > 8) continue;
    out = out.flatMap((v) => options.map((o) => ({ ...v, [f.key]: o })));
    if (out.length > 240) return out.slice(0, 240);
  }
  return out;
}

type Finding = { tool: string; capability: string; problem: string };

/** Everything wrong with one tool, across every setting of its switches. */
function audit(t: Tool): Finding[] {
  const found: Finding[] = [];
  const seen = new Set<string>();
  const add = (capability: string, problem: string) => {
    const k = `${capability}|${problem}`;
    if (seen.has(k)) return;
    seen.add(k);
    found.push({ tool: t.id, capability, problem });
  };

  for (const v of combos(t)) {
    const capability = (t.capabilityFor?.(v) ?? t.capability) as Capability;
    const needsPhoto = t.needsSourceFor?.(v) ?? t.needsSource;
    const accepted = new Set(capabilityFields(capability));

    if (needsPhoto && !ownsSource(t) && !acceptsSourceKey(capability))
      add(capability, 'leans on the canvas photo, but that capability cannot take one — the photo would be stripped in silence');

    const sent = coerceParams(t, v);
    const dropped = Object.keys(sent).filter((k) => k !== 'sourceKey' && !accepted.has(k));
    if (dropped.length) add(capability, `collects and sends fields the schema will discard: ${dropped.join(', ')}`);

    // A pressable button must produce a valid request. "Add a photo first" is
    // handled by the panel, so a tool waiting for one is not a failure here.
    if (missingFor(t, v) === null && !(needsPhoto && !ownsSource(t))) {
      const params: Record<string, unknown> = { ...sent };
      if (acceptsSourceKey(capability) && !params.sourceKey) params.sourceKey = 'ws/2026/01/x/source.jpg';
      const parsed = parseCapabilityParams(capability, params);
      if (!parsed.ok) add(capability, `the button is pressable but the request is invalid: ${JSON.stringify(parsed.issues)}`);
    }
  }
  return found;
}

const say = (f: Finding[]) => f.map((x) => `${x.tool} → ${x.capability}: ${x.problem}`).join('\n');

describe('every studio tool, against the schema it sends to', () => {
  // A plain loop rather than it.each: one named test per tool, so a failure
  // says WHICH tool broke in its own line, and the tuple typing that made
  // this file fragile is gone.
  for (const tool of TOOLS) {
    it(`${tool.id} sends only what its capability accepts`, () => {
      const findings = audit(tool);
      expect(say(findings), `\n${say(findings)}\n`).toBe('');
    });
  }
});

describe('the audit itself', () => {
  /** The flyer's exact shape on the day it threw a customer's photo away. */
  const canary = {
    id: 'canary',
    label: 'Canary',
    short: 'Canary',
    icon: 'today',
    capability: 'IMAGE_GENERATE',
    needsSource: true,
    narrative: {},
    fields: [{ key: 'vibe', kind: 'text', label: 'Vibe' }],
    defaults: { vibe: 'warm', prompt: 'a birthday flyer' },
  } as unknown as Tool;

  it('still fails when a tool would drop the customer photo', () => {
    const problems = audit(canary).map((f) => f.problem);
    expect(problems.some((p) => p.includes('cannot take one'))).toBe(true);
  });

  it('still fails when a tool collects a field nothing will read', () => {
    expect(audit(canary).some((f) => f.problem.includes('vibe'))).toBe(true);
  });
});

/**
 * Finding the tool, which is the other half of the same bug.
 *
 * The audit above proves a tool does the right thing once it is chosen. This
 * proves it can be chosen at all: fifteen tools in a flat strip is a wall,
 * and a merchant who cannot find Batch concludes the studio cannot do forty
 * photos — which is exactly as bad as it dropping their photo.
 *
 * The search is tested with the words a seller would actually type, not the
 * names we gave the tools. Nobody types "ghost mannequin"; they type
 * "mannequin", or "wrinkle", or "yoruba".
 */
describe('finding a tool', () => {
  it('has a sentence and a group for every tool in the strip', () => {
    for (const t of TOOLS) {
      const meta = TOOL_META[t.id];
      expect(meta, `${t.id} is in the studio but not in the sheet`).toBeTruthy();
      expect(meta.blurb.length, `${t.id} has no sentence saying what it is for`).toBeGreaterThan(12);
      expect(TOOL_GROUPS[meta.group], `${t.id} is filed under a group that does not exist`).toBeTruthy();
    }
  });

  it('has no empty group — a heading with nothing under it reads as a bug', () => {
    for (const g of Object.keys(TOOL_GROUPS) as ToolGroup[]) expect(toolsIn(g).length, g).toBeGreaterThan(0);
  });

  it('shows the whole studio before anyone types', () => {
    expect(searchTools('')).toHaveLength(TOOLS.length);
    expect(searchTools('   ')).toHaveLength(TOOLS.length);
  });

  /** The words, and the one tool each of them has to reach. */
  const asked: Array<[string, ToolId]> = [
    ['wrinkle', 'shots'],
    ['mannequin', 'shots'],
    ['okrika', 'shots'],
    ['yoruba', 'translate'],
    ['hashtag', 'copy'],
    ['jingle', 'music'],
    ['transparent', 'cutout'],
    ['blurry', 'enhance'],
    ['birthday', 'flyer'],
    ['forty', 'batch'],
    ['tiktok', 'video'],
  ];
  for (const [word, id] of asked) {
    it(`“${word}” finds ${id}`, () => {
      const found = searchTools(word).map((t) => t.id);
      expect(found, `“${word}” found ${found.join(', ') || 'nothing'}`).toContain(id);
    });
  }

  it('matches on every word typed, not just one of them', () => {
    // "remove background" must not return everything that mentions background.
    const found = searchTools('remove background').map((t) => t.id);
    expect(found).toContain('cutout');
    expect(found).not.toContain('music');
  });

  it('does not care about case or stray spaces', () => {
    expect(searchTools('  MANNEQUIN ').map((t) => t.id)).toContain('shots');
  });

  it('comes back empty rather than wrong when nothing matches', () => {
    expect(searchTools('zzzz-nothing-here')).toHaveLength(0);
  });

  /**
   * The same rule as the progress lines: a merchant reads these sentences,
   * and they must not name a supplier we may not be using next month.
   */
  it('never names a vendor in a label, a sentence or a search word', () => {
    for (const t of TOOLS) {
      const meta = TOOL_META[t.id];
      for (const [what, text] of [
        ['label', t.label],
        ['short', t.short],
        ['blurb', meta.blurb],
        ['keywords', meta.keywords],
      ] as const)
        expect(namesAVendor(text), `${t.id} ${what}: ${text}`).toBe(false);
    }
    for (const g of Object.values(TOOL_GROUPS)) {
      expect(namesAVendor(g.label), g.label).toBe(false);
      expect(namesAVendor(g.note), g.note).toBe(false);
    }
  });
});

/**
 * Sifting the results.
 *
 * A result carries the capability it used, not the tool that asked for it —
 * two tools can share one capability, and a row outlives the tool list it was
 * made from. So the filter maps from the capability, and the thing that can
 * silently rot is a capability added to the product and never filed here: it
 * would vanish from every filter except All, which is exactly the kind of
 * disappearance nobody reports as a bug.
 */
describe('filtering what has been made', () => {
  it('files every capability that can produce a result', () => {
    // BATCH is filed too — its own row is what a merchant sees for the shoot.
    const notAResult: Capability[] = ['VIDEO_STITCH'];
    for (const c of CAPABILITIES) {
      if (notAResult.includes(c)) continue;
      expect(groupOfCapability(c), `${c} belongs to no group, so it can never be filtered to`).toBeTruthy();
    }
  });

  it('puts each one where a merchant would look for it', () => {
    expect(groupOfCapability('PRODUCT_SHOT')).toBe('photo');
    expect(groupOfCapability('COLLAGE')).toBe('photo');
    expect(groupOfCapability('IMAGE_TO_VIDEO')).toBe('video');
    // A dub and a lip-sync hand back a video, whatever they did to get there.
    expect(groupOfCapability('DUB')).toBe('video');
    expect(groupOfCapability('LIPSYNC')).toBe('video');
    expect(groupOfCapability('MUSIC')).toBe('sound');
    expect(groupOfCapability('VOICEOVER')).toBe('sound');
    expect(groupOfCapability('TEXT_GENERATE')).toBe('words');
    expect(groupOfCapability('BATCH')).toBe('bulk');
  });

  it('says nothing rather than guessing about a capability it does not know', () => {
    // A row from a newer server than this build. It belongs to no group and
    // so is never filtered out — invisible is the one outcome to avoid.
    expect(groupOfCapability('SOMETHING_NEW')).toBeUndefined();
  });
});

/**
 * What to offer when a shot comes back wrong.
 *
 * "Try again" on a generation that could not keep the product is an offer to
 * fail the same way for the same money. The fidelity check refuses precisely
 * when the model returned something that is not the seller's item, and the
 * one known remedy is more photos of it. So the card offers the remedy — but
 * only where there is one, and a wrong offer here is worse than none: it
 * spends a merchant's trust on advice that cannot work.
 */
describe('offering the fix that exists', () => {
  const shots = toolById('shots');

  it('offers more angles when a merchant shot could not keep the product', () => {
    expect(anglesWouldHelp(shots, { mode: 'on_model', angleKeys: [] }, 'LOW_QUALITY')).toBe(true);
  });

  it('says nothing for a failure that more photos cannot fix', () => {
    for (const kind of ['TIMEOUT', 'PROVIDER_DOWN', 'RATE_LIMITED', 'CONTENT_REJECTED', 'REQUEST_REJECTED', 'INVALID_INPUT', null, undefined])
      expect(anglesWouldHelp(shots, { mode: 'on_model', angleKeys: [] }, kind), String(kind)).toBe(false);
  });

  it('says nothing on the modes the vendor will not read angles for', () => {
    // Offering them elsewhere asks for uploads nothing will look at, which is
    // a worse failure than the one it is trying to fix.
    for (const mode of ['ghost_mannequin', 'flat_lay', 'ironing', 'beautify', 'expand', 'text_removal'])
      expect(anglesWouldHelp(shots, { mode, angleKeys: [] }, 'LOW_QUALITY'), mode).toBe(false);
  });

  it('stops asking once there is nothing left to ask for', () => {
    const full = Array.from({ length: PRODUCT_REFERENCE_ANGLES.max }, (_, i) => `ws/a${i}.jpg`);
    expect(anglesWouldHelp(shots, { mode: 'on_model', angleKeys: full }, 'LOW_QUALITY')).toBe(false);
    // One short of the ceiling still has room.
    expect(anglesWouldHelp(shots, { mode: 'on_model', angleKeys: full.slice(1) }, 'LOW_QUALITY')).toBe(true);
  });

  it('says nothing for a tool that has no angles at all', () => {
    for (const id of ['copy', 'music', 'collage', 'video'] as const) expect(anglesWouldHelp(toolById(id), { mode: 'on_model' }, 'LOW_QUALITY'), id).toBe(false);
  });
});

/**
 * The words a reel is made from, and who wrote them.
 *
 * The format's direction was only ever a placeholder — grey, and gone the
 * moment anyone typed a character — so a seller could use this tool without
 * ever noticing the format was writing their reel. It is a choice now, and
 * taking it shows the words rather than hinting at them.
 *
 * The switch is panel state only. That matters: the server fills a blank
 * prompt from the format regardless, so if `brief` ever reached the API it
 * would be a key nothing reads — the exact failure this repo has a whole
 * audit for.
 */
describe('the words a reel is made from', () => {
  const video = toolById('video');

  it('starts on the format but asks for a voice when narration is enabled', () => {
    expect(video.defaults.brief).toBe('format');
    expect(missingFor(video, video.defaults)).toBe('Pick narrator voice.');
    expect(missingFor(video, { ...video.defaults, narrationEnabled: false })).toBeNull();
  });

  it('hides the box until someone takes the pen', () => {
    const promptField = video.fields.find((f) => f.key === 'prompt')!;
    expect(promptField.showIf?.({ brief: 'format' })).toBe(false);
    expect(promptField.showIf?.({ brief: 'own' })).toBe(true);
  });

  it('quotes the chosen format back, so the words are read and not guessed at', () => {
    const brief = video.fields.find((f) => f.key === 'brief') as Extract<(typeof video.fields)[number], { kind: 'segment' }>;
    const note = brief.noteFor?.({ brief: 'format', format: 'price_drop' });
    expect(note).toContain(REEL_BRIEF.price_drop);
    // And says nothing when the seller is writing their own.
    expect(brief.noteFor?.({ brief: 'own', format: 'price_drop' })).toBeUndefined();
  });

  it('never sends the switch itself', () => {
    // It decides what the panel shows. The API has no such field, and a key
    // nothing reads is the bug this file exists to catch.
    for (const brief of ['format', 'own']) {
      const sent = coerceParams(video, { ...video.defaults, brief, prompt: brief === 'own' ? 'hold on the label' : '' });
      expect(Object.keys(sent), brief).not.toContain('brief');
    }
  });

  it('sends the seller’s words when they wrote some, and nothing when they did not', () => {
    expect(coerceParams(video, { ...video.defaults, brief: 'own', prompt: 'hold on the label' }).prompt).toBe('hold on the label');
    // Blank goes as absent, and the server fills it from the format — the one
    // place that decision is made.
    expect(coerceParams(video, { ...video.defaults, brief: 'format' }).prompt).toBeUndefined();
  });
});

describe('cut or scene, across two catalogues', () => {
  const scene = TOOLS.find((t) => t.id === 'scene')!;

  it('reads a preset directly, because presets are compiled in', () => {
    expect(isCutChoice({ preset: 'white' })).toBe(true);
    expect(isCutChoice({ preset: 'studio_blush' })).toBe(false);
    expect(isCutChoice({})).toBe(false);
  });

  it('reads a template from the values, because the catalogue is fetched and this runs synchronously', () => {
    // A cut template clears the prompt and writes a background; a scene
    // template writes the prompt. `templateParams` on the API side is what
    // makes that true, and this is the assertion that would break if it
    // stopped being true.
    expect(isCutChoice({ template: 'general_white', background: '#FFFFFF', prompt: '' })).toBe(true);
    expect(isCutChoice({ template: 'furniture_living_warm', prompt: 'A warm living room.' })).toBe(false);
    // A background left over from a previous pick must not turn a scene into
    // a cut — the prompt is what decides.
    expect(isCutChoice({ template: 'furniture_living_warm', background: '#FFFFFF', prompt: 'A warm living room.' })).toBe(false);
  });

  it('prices a cut as a background removal and a scene as an edit', () => {
    expect(scene.capabilityFor!({ preset: 'white' })).toBe('BACKGROUND_REMOVE');
    expect(scene.capabilityFor!({ template: 'general_white', background: '#FFFFFF', prompt: '' })).toBe('BACKGROUND_REMOVE');
    expect(scene.capabilityFor!({ template: 'furniture_living_warm', prompt: 'A warm living room.' })).toBe('IMAGE_EDIT');
  });

  it('hides the fields a cut has nothing to say about, whichever catalogue chose it', () => {
    // A cut-out onto a flat colour has no setting to describe and no shape to
    // pick. Showing those fields for a template but not a preset would be the
    // same control behaving differently for no reason a seller could see.
    const hidden = (values: Record<string, unknown>) => scene.fields.filter((f) => 'showIf' in f && f.showIf && !f.showIf(values)).map((f) => f.key);
    const byPreset = hidden({ preset: 'white' });
    const byTemplate = hidden({ template: 'general_white', background: '#FFFFFF', prompt: '' });
    expect(byPreset).toContain('prompt');
    expect(byTemplate).toEqual(byPreset);
  });

  it('offers the room picker on the scene tool', () => {
    expect(scene.fields.find((f) => f.kind === 'templates')?.key).toBe('template');
  });
});

describe('the price box speaks the seller’s money', () => {
  const priceFields = TOOLS.flatMap((t) => t.fields.filter((f) => f.key === 'price').map((f) => [t.id, f] as const));

  it('offers a price example on every tool that takes one', () => {
    expect(priceFields.length).toBeGreaterThan(3);
    for (const [tool, field] of priceFields) {
      expect(field.kind, tool).toBe('text');
      // A fixed `placeholder` here is the bug: it tells a London seller to
      // type naira. The example has to be resolved against the workspace.
      expect('placeholderFor' in field && typeof field.placeholderFor === 'function', tool).toBe(true);
    }
  });

  it.each([
    ['NGN', '₦'],
    ['USD', '$'],
    ['GBP', '£'],
  ])('shows %s prices with %s', (currency, symbol) => {
    for (const [tool, field] of priceFields) {
      const shown = 'placeholderFor' in field ? field.placeholderFor?.({}, { currency }) : undefined;
      expect(shown, `${tool} in ${currency}`).toContain(symbol);
    }
  });

  it('falls back to dollars for a currency it has no example for', () => {
    // A workspace whose currency is not a market currency must still get a
    // sensible box rather than an empty one.
    expect(priceExample('KES')).toBe('$25');
    expect(priceExample(undefined)).toBe('$25');
  });

  it('never sends the example — a placeholder is not a value', () => {
    const scene = TOOLS.find((t) => t.id === 'scene')!;
    expect(coerceParams(scene, { ...scene.defaults, prompt: 'on a marble counter' }).price).toBeUndefined();
  });
});
