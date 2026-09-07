/**
 * What we hand Gemini as a response schema.
 *
 * Gemini's dialect rejects a handful of JSON-Schema keywords, so we drop
 * them. The trap is that a keyword name and a property name are different
 * things that look identical from inside a recursive walk — and the studio's
 * ideas schema has a property called `title`, which is also an annotation
 * keyword. Deleting it left `required: ['title', …]` pointing at nothing,
 * every request 400'd, and the caller served stock ideas without a word.
 *
 * So these tests are about the difference between a keyword and a name.
 */
import { describe, expect, it } from 'vitest';
import { parseJson, stripUnsupported } from './google.adapter';

/** The shape the studio actually sends — the one that broke. */
const IDEAS = {
  type: 'object',
  additionalProperties: false,
  required: ['ideas'],
  properties: {
    product: { type: 'string', description: 'The product in the photo' },
    ideas: {
      type: 'array',
      minItems: 3,
      maxItems: 3,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'prompt', 'why'],
        properties: {
          title: { type: 'string', description: 'Three to five words' },
          prompt: { type: 'string', description: 'The direction, ready to paste' },
          motion: { type: 'string', description: 'Video only' },
          why: { type: 'string', description: 'One sentence' },
        },
      },
    },
  },
} as const;

type Node = Record<string, unknown>;
const at = (schema: Node, path: string[]): Node => path.reduce((n, k) => (n as Record<string, Node>)[k]!, schema as Node);

describe('the schema handed to Gemini', () => {
  it('keeps every property the schema says is required', () => {
    const out = stripUnsupported(IDEAS as unknown as Node);
    const item = at(out, ['properties', 'ideas', 'items']);
    const required = item.required as string[];
    const properties = item.properties as Node;
    // The exact contract Gemini checks, and the exact one we were failing.
    for (const name of required) expect(properties, `required property "${name}" was stripped out of the schema`).toHaveProperty(name);
  });

  it('does not confuse a property named "title" with the title keyword', () => {
    const out = stripUnsupported(IDEAS as unknown as Node);
    expect(at(out, ['properties', 'ideas', 'items', 'properties'])).toHaveProperty('title');
  });

  it('still drops the keywords Gemini refuses', () => {
    const out = stripUnsupported({
      type: 'object',
      title: 'Ignored by Gemini',
      additionalProperties: false,
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      properties: { a: { type: 'string', default: 'x', examples: ['y'] } },
    });
    expect(out).not.toHaveProperty('title');
    expect(out).not.toHaveProperty('additionalProperties');
    expect(out).not.toHaveProperty('$schema');
    expect(at(out, ['properties', 'a'])).not.toHaveProperty('default');
    expect(at(out, ['properties', 'a'])).not.toHaveProperty('examples');
  });

  it('leaves properties alone even when they are named after keywords', () => {
    // `default` and `examples` are the same trap as `title`, waiting.
    const out = stripUnsupported({
      type: 'object',
      required: ['default', 'examples'],
      properties: { default: { type: 'string' }, examples: { type: 'string' } },
    });
    expect(out.properties).toHaveProperty('default');
    expect(out.properties).toHaveProperty('examples');
  });

  it('does not disturb a schema with nothing to strip', () => {
    const plain = { type: 'object', required: ['a'], properties: { a: { type: 'string' } } };
    expect(stripUnsupported(plain)).toEqual(plain);
  });
});

describe('reading the answer back', () => {
  it('unwraps a fenced JSON block, which the models add unasked', () => {
    expect(parseJson('google:x', '```json\n{"ideas":[]}\n```')).toEqual({ ideas: [] });
  });
});
