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
import { acceptsSourceKey, capabilityFields, namesAVendor, parseCapabilityParams, type Capability } from '@anystudio/shared';
import { TOOLS, TOOL_GROUPS, TOOL_META, coerceParams, missingFor, searchTools, toolsIn, type Tool, type ToolGroup, type ToolId } from './tools';

/** Whether the tool brings its own source rather than using the canvas photo. */
const ownsSource = (t: Tool): boolean => t.fields.some((f) => (f.kind === 'file' && f.key === 'sourceKey') || f.kind === 'photos');

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
