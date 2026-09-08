/**
 * Which adapters exist in this process, keyed the way ProviderModel rows name
 * them.
 *
 * An adapter is registered only when its credential is present, so a row for
 * a vendor we hold no key for is simply unroutable — logged once at startup,
 * not discovered at the first customer's request. The stub adapter is
 * registered in every non-production environment so the pipeline can be
 * exercised end to end with no vendor at all.
 */

import { Injectable } from '@nestjs/common';
import type { Capability, GenerationProvider } from '@anystudio/shared';
import { logger } from '../../../config/logger';
import { isProductionDeployment } from '../../../config/environment';
import { StubProvider } from './adapters/stub.adapter';
import { SyncProvider } from './adapters/sync.adapter';
import { FalProvider } from './adapters/fal.adapter';
import { GoogleProvider } from './adapters/google.adapter';
import { ReplicateProvider } from './adapters/replicate.adapter';
import { PhotoroomProvider } from './adapters/photoroom.adapter';
import { OpenAiProvider } from './adapters/openai.adapter';
import { AnthropicProvider } from './adapters/anthropic.adapter';
import { BflProvider } from './adapters/bfl.adapter';
import { LocalProvider } from './adapters/local.adapter';
import { HiggsfieldProvider } from './adapters/higgsfield.adapter';
import { ElevenLabsProvider } from './adapters/elevenlabs.adapter';
import { HeyGenProvider } from './adapters/heygen.adapter';

/**
 * Vendor keys whose test variant is distinguishable from the live one, and
 * what to read to tell them apart. Only vendors that actually mark their test
 * keys belong here: a guess would either miss the real thing or cry wolf at a
 * live key that happens to contain a word.
 */
const SANDBOX_KEYS = ['PHOTOROOM_API_KEY'] as const;

@Injectable()
export class ProviderRegistry {
  private readonly byKey = new Map<string, GenerationProvider>();

  constructor() {
    const env = process.env;
    const isProd = isProductionDeployment(env);

    const candidates: Array<{ present: boolean; make: () => GenerationProvider[] }> = [
      { present: !isProd, make: () => [new StubProvider()] },
      { present: true, make: () => [new LocalProvider()] },
      { present: Boolean(env.FAL_KEY), make: () => FalProvider.all(env.FAL_KEY!) },
      {
        present: Boolean(env.GOOGLE_AI_API_KEY || env.GOOGLE_VERTEX_SA_JSON),
        make: () =>
          GoogleProvider.all({
            apiKey: env.GOOGLE_AI_API_KEY,
            saJson: env.GOOGLE_VERTEX_SA_JSON,
            project: env.GOOGLE_VERTEX_PROJECT,
            location: env.GOOGLE_VERTEX_LOCATION,
          }),
      },
      { present: Boolean(env.REPLICATE_API_TOKEN), make: () => ReplicateProvider.all(env.REPLICATE_API_TOKEN!) },
      { present: Boolean(env.PHOTOROOM_API_KEY), make: () => PhotoroomProvider.all(env.PHOTOROOM_API_KEY!) },
      { present: Boolean(env.OPENAI_API_KEY), make: () => OpenAiProvider.all(env.OPENAI_API_KEY!) },
      { present: Boolean(env.ANTHROPIC_API_KEY), make: () => AnthropicProvider.all(env.ANTHROPIC_API_KEY!) },
      { present: Boolean(env.BFL_API_KEY), make: () => BflProvider.all(env.BFL_API_KEY!) },
      {
        present: Boolean(env.HIGGSFIELD_API_KEY && env.HIGGSFIELD_API_SECRET),
        make: () => HiggsfieldProvider.all(env.HIGGSFIELD_API_KEY!, env.HIGGSFIELD_API_SECRET!),
      },
      { present: Boolean(env.HEYGEN_API_KEY), make: () => HeyGenProvider.all(env.HEYGEN_API_KEY!) },
      { present: Boolean(env.ELEVENLABS_API_KEY), make: () => ElevenLabsProvider.all(env.ELEVENLABS_API_KEY!) },
      { present: Boolean(env.SYNC_API_KEY), make: () => SyncProvider.all(env.SYNC_API_KEY!) },
    ];

    for (const c of candidates) {
      if (!c.present) continue;
      for (const p of c.make()) this.byKey.set(p.key, p);
    }

    /**
     * A TEST KEY IN PRODUCTION IS INVISIBLE UNTIL A CUSTOMER SEES IT.
     *
     * Photoroom's sandbox key is free, runs the real models, and stamps a
     * watermark across everything it returns. That makes it perfect for
     * verifying an adapter and catastrophic to deploy: nothing fails, no
     * error is logged, credits are spent, and the first person to notice is
     * a merchant looking at their own product covered in another company's
     * name. It has already happened here once.
     *
     * A key is a string in an environment group, and the two look identical
     * at a glance, so the only reliable guard is the machine reading it.
     */
    if (isProd) {
      // Read here, not at module load: the environment file may not be in
      // place when this file is first imported.
      const sandbox = SANDBOX_KEYS.filter((name) => /sandbox/i.test(env[name] ?? ''));
      if (sandbox.length) {
        logger.fatal({ vars: sandbox }, 'A sandbox provider key is set in production; refusing to serve watermarked output to paying customers.');
        throw new Error(`Sandbox provider credentials are not allowed in production: ${sandbox.join(', ')}`);
      }
    }

    logger.info(
      { providers: [...this.byKey.keys()], count: this.byKey.size },
      this.byKey.size > 1 ? 'provider adapters registered' : 'no vendor credentials set: only the stub and local adapters are available',
    );
  }

  get(key: string): GenerationProvider | undefined {
    return this.byKey.get(key);
  }

  keys(): string[] {
    return [...this.byKey.keys()];
  }

  /** Adapters able to serve a capability, regardless of routing rows. */
  supporting(capability: Capability): GenerationProvider[] {
    return [...this.byKey.values()].filter((p) => p.supports(capability));
  }

  /** Tests and the worker's self-check register fakes through here. */
  register(provider: GenerationProvider): void {
    this.byKey.set(provider.key, provider);
  }
}
