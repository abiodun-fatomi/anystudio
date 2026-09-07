/**
 * Photoroom — the e-commerce specialist: background replacement with a
 * generated scene, AI shadows and relighting in one synchronous call.
 *
 *   GET https://image-api.photoroom.com/v2/edit?imageUrl=…&background.prompt=…&shadow.mode=…&lighting.mode=…
 * Returns the image bytes directly; errors come back as JSON.
 */

import {
  PRODUCT_SIZE_BY_ASPECT,
  ProviderError,
  SHADOW_STYLES,
  SHOT_SIZES,
  type Capability,
  type CapabilityParams,
  type ProviderInput,
  type ProviderOpts,
  type ProviderResult,
} from '@anystudio/shared';
import { BaseProvider } from './base';
import { kindForStatus } from './http';

const KNOWN: Record<string, Capability[]> = {
  'photoroom:edit': ['BACKGROUND_REPLACE', 'RELIGHT', 'BACKGROUND_REMOVE', 'PRODUCT_SHOT'],
};

/**
 * One mode, one set of query fields — the names taken from the vendor's own
 * OpenAPI document, not from the shape of its app.
 *
 * That distinction cost a rewrite. The first version of this table guessed
 * `recolor.*`, `retouch.*`, `beautify.prompt`, `expand.prompt`, a top-level
 * `size` and `referenceImages[]`, because the app has all of those. None of
 * them are in the specification. A parameter a vendor does not know is not an
 * error — it is ignored, billed, and the customer gets back a picture that
 * quietly did not do what they asked. Only fields the spec lists appear here.
 *
 * `p` is already validated; the schema refuses anything a mode cannot work
 * without, so nothing below re-checks.
 */
type ShotParams = CapabilityParams<'PRODUCT_SHOT'>;

/** The per-feature frame name, for the modes whose size is set on themselves. */
const sizeOf = (p: ShotParams): string => PRODUCT_SIZE_BY_ASPECT[p.aspect] ?? 'SQUARE_HD';

const MODE_FIELDS: Partial<Record<ShotParams['mode'], (p: ShotParams, q: URLSearchParams, files: ProviderInput['files']) => void>> = {
  on_model: (p, q, files) => {
    q.set('virtualModel.mode', 'ai.auto');
    // A person wearing the garment IS the new background, so cutting the old
    // one out first is both wasted work and, per the vendor, refused.
    q.set('removeBackground', 'false');
    // `model` and `scene` are objects, not strings: each is either a named
    // preset or a photo of your own. The dotted query path is how the vendor
    // spells a nested field, so it is `.preset.name`, never a bare value —
    // sending the bare value is a 400 that says "must match a schema in anyOf".
    const photo = files.modelPhotoKey?.url;
    if (photo) q.set('virtualModel.model.custom.imageUrl', photo);
    else if (p.model && p.model !== 'custom') q.set('virtualModel.model.preset.name', p.model);
    q.set('virtualModel.scene.preset.name', p.scene ?? 'random');
    // Pose really is a plain string — the one flat field of the three.
    q.set('virtualModel.pose', p.pose ?? 'random');
    q.set('virtualModel.size', sizeOf(p));
    // Roughly 1K, 2K or 4K on the long side. The only mode with this
    // parameter; sending it elsewhere would send a key nothing reads.
    q.set('virtualModel.quality', SHOT_SIZES[p.shotSize].vendor);
    if (p.prompt) q.set('virtualModel.prompt', p.prompt);
    // The only place the vendor accepts more angles of the product. Elsewhere
    // the extra photos are ours to keep for a retry, not the vendor's to read.
    for (const name of Object.keys(files)
      .filter((n) => n.startsWith('angleKeys['))
      .sort())
      q.append('virtualModel.additionalProductImages', files[name]!.url);
  },
  ghost_mannequin: (p, q) => {
    q.set('ghostMannequin.mode', 'ai.auto');
    q.set('ghostMannequin.size', sizeOf(p));
    if (p.prompt) q.set('ghostMannequin.prompt', p.prompt);
  },
  flat_lay: (p, q) => {
    q.set('flatLay.mode', 'ai.auto');
    q.set('flatLay.size', sizeOf(p));
    if (p.prompt) q.set('flatLay.prompt', p.prompt);
  },
  // No options at all in the spec, and none in their app either: a photo in, a pressed photo out.
  ironing: (_p, q) => q.set('ironing.mode', 'ai.auto'),
  // `beautify` takes a subject tuning and a seed. There is no prompt.
  beautify: (p, q) => q.set('beautify.mode', `ai.${p.subject}`),
  // Widening the frame is the whole point, so this one must not keep the original size.
  expand: (_p, q) => {
    q.set('expand.mode', 'ai.auto');
    q.set('outputSize', 'auto');
    // The vendor refuses outright: "expand.mode will activate when
    // `removeBackground` is set to false". Which is right — continuing the
    // surroundings requires surroundings to continue.
    q.set('removeBackground', 'false');
  },
};

export class PhotoroomProvider extends BaseProvider {
  static all(apiKey: string): PhotoroomProvider[] {
    return Object.entries(KNOWN).map(([key, caps]) => new PhotoroomProvider(apiKey, key, caps));
  }

  constructor(
    private readonly apiKey: string,
    key: string,
    capabilities: Capability[],
  ) {
    super(key, capabilities);
  }

  async generate(input: ProviderInput, opts: ProviderOpts): Promise<ProviderResult> {
    const q = new URLSearchParams({ imageUrl: this.file(input, 'sourceKey'), outputSize: 'originalImage', 'export.format': 'png' });
    switch (input.capability) {
      case 'BACKGROUND_REPLACE': {
        const p = this.params(input, 'BACKGROUND_REPLACE');
        q.set('background.prompt', p.prompt);
        if (p.shadow) q.set('shadow.mode', this.str(input.config, 'shadow', 'ai.soft'));
        if (p.relight) q.set('lighting.mode', 'ai.auto');
        break;
      }
      case 'RELIGHT': {
        q.set('lighting.mode', 'ai.auto');
        q.set('shadow.mode', this.str(input.config, 'shadow', 'ai.soft'));
        break;
      }
      case 'BACKGROUND_REMOVE': {
        const p = this.params(input, 'BACKGROUND_REMOVE');
        if (p.background !== 'transparent') q.set('background.color', p.background.slice(1));
        break;
      }
      case 'PRODUCT_SHOT': {
        const p = this.params(input, 'PRODUCT_SHOT');
        const fields = MODE_FIELDS[p.mode];
        // A mode with no mapping is one whose parameters we have not confirmed.
        // Refusing here is free; sending a request the vendor half-understands
        // is not, and the customer pays for the half.
        if (!fields) throw new ProviderError('INVALID_INPUT', `${this.key} cannot do "${p.mode}" yet`, this.key);
        fields(p, q, input.files);
        const shadow = SHADOW_STYLES[p.shadow].mode;
        if (shadow) q.set('shadow.mode', shadow);
        break;
      }
      default:
        return this.unsupported(input.capability);
    }

    opts.onProgress?.('Editing your photo', 30);
    const res = await fetch(`https://image-api.photoroom.com/v2/edit?${q.toString()}`, {
      headers: { 'x-api-key': this.apiKey, accept: 'image/png, application/json' },
      signal: AbortSignal.timeout(opts.timeoutMs),
    }).catch((err: Error) => {
      throw new ProviderError('RETRYABLE', `${this.key}: ${err.message}`, this.key);
    });

    const mime = res.headers.get('content-type')?.split(';')[0] ?? '';
    if (!res.ok || !mime.startsWith('image/')) {
      const text = await res.text();
      const kind = res.status === 400 && /prompt|content|policy/i.test(text) ? 'CONTENT_REJECTED' : kindForStatus(res.status);
      throw new ProviderError(kind, `${this.key}: HTTP ${res.status}: ${text.slice(0, 400)}`, this.key, { status: res.status });
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { providerKey: this.key, providerJobId: res.headers.get('x-request-id') ?? undefined, artifacts: [{ bytes, mime, role: 'image' }] };
  }
}
