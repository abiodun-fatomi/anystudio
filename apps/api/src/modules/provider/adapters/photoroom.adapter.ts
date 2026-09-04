/**
 * Photoroom — the e-commerce specialist: background replacement with a
 * generated scene, AI shadows and relighting in one synchronous call.
 *
 *   GET https://image-api.photoroom.com/v2/edit?imageUrl=…&background.prompt=…&shadow.mode=…&lighting.mode=…
 * Returns the image bytes directly; errors come back as JSON.
 */

import { ProviderError, type Capability, type ProviderInput, type ProviderOpts, type ProviderResult } from '@anystudio/shared';
import { BaseProvider } from './base';
import { kindForStatus } from './http';

const KNOWN: Record<string, Capability[]> = {
  'photoroom:edit': ['BACKGROUND_REPLACE', 'RELIGHT', 'BACKGROUND_REMOVE'],
};

export class PhotoroomProvider extends BaseProvider {
  static all(apiKey: string): PhotoroomProvider[] {
    return Object.entries(KNOWN).map(([key, caps]) => new PhotoroomProvider(apiKey, key, caps));
  }

  constructor(private readonly apiKey: string, key: string, capabilities: Capability[]) {
    super(key, capabilities);
  }

  async generate(input: ProviderInput, opts: ProviderOpts): Promise<ProviderResult> {
    const q = new URLSearchParams({ imageUrl: this.file(input, 'sourceKey'), outputSize: 'originalImage', export: 'format=png' });
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
