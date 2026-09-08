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
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderInput } from '@anystudio/shared';
import { GoogleProvider, googleDefaultModel, parseJson, repeatedCallCostMinor, stripUnsupported, veoCostMinor, veoDuration } from './google.adapter';

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

afterEach(() => vi.unstubAllGlobals());

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

  it('quotes numeric enum values, which Gemini reads as strings whatever the type', () => {
    // The shot plan's real shape. Sent as numbers it came back
    //   Invalid value at '…enum[0]' (TYPE_STRING), 5
    // and every ad's plan fell through to the fallback model.
    const out = stripUnsupported({
      type: 'object',
      properties: { durationSec: { type: 'integer', enum: [5, 8] }, tempo: { type: 'string', enum: ['slow', 'fast'] } },
    });
    expect(at(out, ['properties', 'durationSec']).enum).toEqual(['5', '8']);
    expect(at(out, ['properties', 'tempo']).enum).toEqual(['slow', 'fast']);
  });

  it('leaves a property NAMED enum alone', () => {
    const out = stripUnsupported({ type: 'object', required: ['enum'], properties: { enum: { type: 'string' } } });
    expect(at(out, ['properties', 'enum'])).toEqual({ type: 'string' });
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

describe('registering Google providers for the credentials actually present', () => {
  const saJson = JSON.stringify({ client_email: 'worker@example.test', private_key: 'unused in this unit test' });

  it('does not expose Cloud TTS for a Gemini API key', () => {
    expect(GoogleProvider.all({ apiKey: 'ai-key' }).map((p) => p.key)).not.toContain('google:tts');
  });

  it('does not expose Vertex generation for a service account without a project', () => {
    expect(GoogleProvider.all({ saJson }).map((p) => p.key)).toEqual(['google:tts']);
  });

  it('exposes Vertex generation and Cloud TTS for a complete service-account configuration', () => {
    expect(GoogleProvider.all({ saJson, project: 'project-1' }).map((p) => p.key)).toEqual([
      'vertex:gemini-3-pro-image',
      'vertex:veo-3.1-fast',
      'google:gemini-3.5-flash-lite',
      'google:tts',
    ]);
  });

  it('uses the endpoint id supported by each Veo credential door', () => {
    expect(googleDefaultModel('vertex:veo-3.1-fast', false)).toBe('veo-3.1-fast-generate-preview');
    expect(googleDefaultModel('vertex:veo-3.1-fast', true)).toBe('veo-3.1-fast-generate-001');
  });

  it("maps the product duration grid onto Veo 3.1's supported durations", () => {
    expect(veoDuration(4)).toBe(4);
    expect(veoDuration(5)).toBe(6);
    expect(veoDuration(6)).toBe(6);
    expect(veoDuration(8)).toBe(8);
  });

  it('reports Veo cost from the actual snapped seconds at the configured rate', () => {
    expect(veoCostMinor(4, 10)).toBe(40);
    expect(veoCostMinor(8, 10)).toBe(80);
    expect(veoCostMinor(8, 'bad')).toBe(80);
  });

  it('counts every paid call in a multi-image Gemini result', () => {
    expect(repeatedCallCostMinor(4, 7)).toBe(28);
    expect(repeatedCallCostMinor(2, undefined)).toBeUndefined();
  });

  it('requests six seconds for a five-second slot so assembly can trim instead of freeze-padding', async () => {
    let submittedBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const target = String(url);
        if (target === 'https://source/image.png') {
          return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } });
        }
        if (target.includes(':predictLongRunning')) {
          submittedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return new Response(JSON.stringify({ name: 'operations/veo-new' }), { headers: { 'content-type': 'application/json' } });
        }
        if (target.includes('/operations/veo-new')) {
          return new Response(
            JSON.stringify({ done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: 'https://cdn.google/video.mp4' } }] } } }),
            { headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response(new Uint8Array([4, 5, 6]), { headers: { 'content-type': 'video/mp4' } });
      }),
    );
    const provider = GoogleProvider.all({ apiKey: 'key' }).find((p) => p.key === 'vertex:veo-3.1-fast')!;
    const result = await provider.generate(
      {
        generationId: 'g1',
        workspaceId: 'w1',
        capability: 'IMAGE_TO_VIDEO',
        params: { sourceKey: 'x', prompt: 'move', durationSec: 5, aspect: '9:16', audio: false, shots: 1, format: 'reveal' },
        files: { sourceKey: { url: 'https://source/image.png', mime: 'image/png' } },
        config: { costPerSecondMinor: 10 },
      },
      { timeoutMs: 1_000, signal: new AbortController().signal },
    );

    expect(submittedBody).toMatchObject({ parameters: { durationSeconds: 6 } });
    expect(result.artifacts[0]).toMatchObject({ role: 'video', durationMs: 6_000 });
    expect(result.costMinor).toBe(60);
  });

  it('resumes a persisted Veo operation without sending predictLongRunning again', async () => {
    const calls: string[] = [];
    let downloadSignal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        calls.push(String(url));
        if (String(url).includes('/operations/')) {
          return new Response(
            JSON.stringify({ done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: 'https://cdn.google/video.mp4' } }] } } }),
            { headers: { 'content-type': 'application/json' } },
          );
        }
        downloadSignal = init?.signal as AbortSignal | undefined;
        return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'video/mp4' } });
      }),
    );
    const provider = GoogleProvider.all({ apiKey: 'key' }).find((p) => p.key === 'vertex:veo-3.1-fast')!;
    const source: ProviderInput = {
      generationId: 'g1',
      workspaceId: 'w1',
      capability: 'IMAGE_TO_VIDEO',
      params: { sourceKey: 'x', prompt: 'move', durationSec: 5, aspect: '9:16', audio: false, shots: 1, format: 'reveal' },
      files: { sourceKey: { url: 'https://source/image.png', mime: 'image/png' } },
      config: {},
    };
    const onSubmitted = vi.fn(async () => undefined);
    const controller = new AbortController();
    const result = await provider.generate(source, {
      timeoutMs: 1_000,
      signal: controller.signal,
      resume: { providerJobId: 'operations/veo-saved' },
      onSubmitted,
    });

    expect(result.providerJobId).toBe('operations/veo-saved');
    expect(onSubmitted).not.toHaveBeenCalled();
    expect(calls).toEqual(['https://generativelanguage.googleapis.com/v1beta/operations/veo-saved', 'https://cdn.google/video.mp4']);
    expect(downloadSignal?.aborted).toBe(false);
    controller.abort(new Error('generation stopped'));
    expect(downloadSignal?.aborted).toBe(true);
  });
});
