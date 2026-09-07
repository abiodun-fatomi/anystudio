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
 * One mode, one set of query fields. A table rather than a switch so adding
 * the next mode is a row — and so the whole mapping can be read at a glance
 * when a vendor renames a field.
 *
 * `p` is the validated params; the schema has already refused anything a mode
 * cannot work without, so nothing here needs to re-check.
 */
type ShotParams = CapabilityParams<'PRODUCT_SHOT'>;
const MODE_FIELDS: Record<ShotParams['mode'], (p: ShotParams, q: URLSearchParams) => void> = {
  on_model: (p, q) => {
    q.set('virtualModel.mode', 'ai.auto');
    // A workspace's own model is passed as an image; a preset by name.
    if (p.model && p.model !== 'custom') q.set('virtualModel.model', p.model);
    q.set('virtualModel.scene', p.scene ?? 'random');
    q.set('virtualModel.pose', p.pose ?? 'random');
    if (p.prompt) q.set('virtualModel.prompt', p.prompt);
  },
  ghost_mannequin: (p, q) => {
    q.set('ghostMannequin.mode', 'ai.auto');
    if (p.prompt) q.set('ghostMannequin.prompt', p.prompt);
  },
  flat_lay: (p, q) => {
    q.set('flatLay.mode', 'ai.auto');
    if (p.prompt) q.set('flatLay.prompt', p.prompt);
  },
  ironing: (_p, q) => q.set('ironing.mode', 'ai.auto'),
  beautify: (p, q) => {
    q.set('beautify.mode', `ai.${p.subject}`);
    if (p.prompt) q.set('beautify.prompt', p.prompt);
  },
  recolor: (p, q) => {
    q.set('recolor.mode', 'ai.auto');
    if (p.color) q.set('recolor.color', p.color.slice(1));
    if (p.part ?? p.prompt) q.set('recolor.prompt', (p.part ?? p.prompt)!);
  },
  retouch: (p, q) => {
    q.set('retouch.mode', 'ai.auto');
    if (p.prompt) q.set('retouch.prompt', p.prompt);
  },
  expand: (p, q) => {
    q.set('expand.mode', 'ai.auto');
    if (p.prompt) q.set('expand.prompt', p.prompt);
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
        MODE_FIELDS[p.mode](p, q);
        // The frame the vendor renders at. `expand` is the one mode that must
        // NOT keep the original size — widening the frame is the whole point.
        if (p.mode === 'expand') q.set('outputSize', 'auto');
        q.set('size', PRODUCT_SIZE_BY_ASPECT[p.aspect] ?? 'SQUARE_HD');
        const shadow = SHADOW_STYLES[p.shadow].mode;
        if (shadow) q.set('shadow.mode', shadow);
        // More angles of the same product: the cheapest quality lever we have,
        // and the reason a drifted result asks for another photo instead of a refund.
        for (const [i, name] of Object.keys(input.files)
          .filter((n) => n.startsWith('angleKeys['))
          .sort()
          .entries())
          q.append(`referenceImages[${i}]`, input.files[name]!.url);
        // Their own model, for a workspace that saved one.
        const modelPhoto = input.files.modelPhotoKey?.url;
        if (p.mode === 'on_model' && modelPhoto) q.set('virtualModel.model', modelPhoto);
        break;
      }
      default:
        return this.unsupported(input.capability);
    }

    opts.onProgress?.('Photoroom is editing', 30);
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
