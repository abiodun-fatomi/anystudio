/**
 * Does a merchant shot actually come back as a picture?
 *
 * Everything under PRODUCT_SHOT typechecks and its tests pass, and none of
 * that is evidence. Every assertion in the suite is against a mock; the one
 * thing nobody has seen is a response from the vendor. A parameter the vendor
 * does not recognise is not an error — it is ignored, billed, and the picture
 * comes back quietly not doing what was asked. That has already happened once
 * in this adapter, to five parameter names at the same time.
 *
 * So this runs the REAL adapter — the class that ships, not a hand-rolled
 * request beside it — once per mode, against a live key, and prints what went
 * out and what came back. If a name is wrong the vendor says so, or the
 * picture is visibly unchanged, and either way it is knowable in a minute
 * instead of after a customer's credits are gone.
 *
 * The key is read from the environment and never printed. Nothing here writes
 * to the database, charges a customer, or touches storage.
 *
 *   PHOTOROOM_API_KEY=… pnpm --filter @anystudio/api exec tsx scripts/verify-photoroom.ts
 *   … --url https://example.com/my-dress.jpg   a product of your own (any public URL)
 *   … --modes ghost_mannequin,on_model         just these
 *   … --out ./shots                            where the pictures land
 *   … --model-photo https://…/me.jpg           put it on a person of your own
 *   … --angles https://…/back.jpg,https://…/side.jpg   more views of the same item
 *
 * One vendor call per mode. Five modes is five of the month's images.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { OFFERED_PRODUCT_MODES, PRODUCT_MODES, parseCapabilityParams, type ProductMode, type ProviderInput } from '@anystudio/shared';
import { PhotoroomProvider } from '../src/modules/provider/adapters/photoroom.adapter';

/** A public product photo, so the script does something useful with no arguments. */
const SAMPLE = 'https://images.unsplash.com/photo-1594633312681-425c7b97ccd1?w=1200&q=80';

const arg = (name: string, fallback = ''): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
};

async function main(): Promise<void> {
  const apiKey = process.env.PHOTOROOM_API_KEY;
  if (!apiKey) {
    console.error('PHOTOROOM_API_KEY is not set. Put it in your shell, not in this file.\n  export PHOTOROOM_API_KEY=…');
    process.exit(2);
  }
  // A placeholder copied out of an instruction is not a key, and finding that
  // out from six identical 401s is a worse minute than finding it out here.
  if (/^(paste|your|xxx|<|\.\.\.)/i.test(apiKey) || apiKey.length < 16) {
    console.error(`PHOTOROOM_API_KEY does not look like a key (${apiKey.length} characters).`);
    console.error('Copy the real one from the Photoroom API dashboard → API keys. It is not your app login.');
    process.exit(2);
  }

  const url = arg('url') || SAMPLE;
  const out = arg('out') || './photoroom-check';
  const asked = arg('modes');
  // Two paths a mock can never exercise: a seller's own model, and the extra
  // angles that stop a model inventing the back of the bag. Both need public
  // URLs, because the vendor fetches them itself.
  const modelPhoto = arg('model-photo');
  const angles = (
    arg('angles')
      ? arg('angles')
          .split(',')
          .map((a) => a.trim())
      : []
  ).filter(Boolean);
  const modes = (asked ? asked.split(',').map((m) => m.trim()) : OFFERED_PRODUCT_MODES) as ProductMode[];

  await mkdir(out, { recursive: true });
  const [provider] = PhotoroomProvider.all(apiKey);
  if (!provider) throw new Error('no provider');

  console.log(`\nProduct photo: ${url}`);
  console.log(`Modes:         ${modes.join(', ')}`);
  if (modelPhoto) console.log(`Model photo:   ${modelPhoto}`);
  if (angles.length) console.log(`Extra angles:  ${angles.length}`);
  console.log(`This will use ${modes.length} of the month's images.\n`);

  let good = 0;
  for (const mode of modes) {
    const label = PRODUCT_MODES[mode]?.label ?? mode;

    // Through the real schema, so the script cannot ask for something the
    // studio could not: a mode that needs a colour or a prompt is refused
    // here exactly as a customer's request would be.
    const parsed = parseCapabilityParams('PRODUCT_SHOT', {
      sourceKey: 'verify/source.jpg',
      mode,
      aspect: '1:1',
      ...(mode === 'on_model'
        ? {
            model: modelPhoto ? 'custom' : 'avery',
            ...(modelPhoto ? { modelPhotoKey: 'verify/model.jpg' } : {}),
            scene: 'studio',
            pose: 'standing',
            shotSize: 'posting',
            angleKeys: angles.map((_, i) => `verify/angle-${i}.jpg`),
          }
        : {}),
      ...(mode === 'recolor' ? { color: '#C8102E' } : {}),
      ...(mode === 'retouch' ? { prompt: 'remove the price tag' } : {}),
    });
    if (!parsed.ok) {
      console.log(`✗ ${label.padEnd(18)} the schema refused it: ${JSON.stringify(parsed.issues)}`);
      continue;
    }

    const input: ProviderInput = {
      generationId: `verify-${mode}`,
      workspaceId: 'verify',
      capability: 'PRODUCT_SHOT',
      params: parsed.params,
      files: {
        sourceKey: { url, mime: 'image/jpeg' },
        ...(modelPhoto ? { modelPhotoKey: { url: modelPhoto, mime: 'image/jpeg' } } : {}),
        ...Object.fromEntries(angles.map((a, i) => [`angleKeys[${i}]`, { url: a, mime: 'image/jpeg' }])),
      },
      config: {},
    };

    const started = Date.now();
    try {
      const result = await provider.generate(input, { timeoutMs: 180_000, signal: AbortSignal.timeout(180_000) });
      const bytes = result.artifacts[0]?.bytes;
      if (!bytes) throw new Error('no bytes came back');
      const meta = await sharp(bytes).metadata();
      const file = join(out, `${mode}.png`);
      await writeFile(file, bytes);
      good++;
      console.log(`✓ ${label.padEnd(18)} ${meta.width}×${meta.height}  ${(bytes.length / 1024).toFixed(0)} KB  ${Date.now() - started}ms  → ${file}`);
    } catch (err) {
      // The vendor's own words, in full: this is the whole point of the run.
      const message = err instanceof Error ? err.message : String(err);
      console.log(`✗ ${label.padEnd(18)} ${Date.now() - started}ms\n    ${message}\n`);
      // Every mode will fail the same way and none of them will be about the
      // adapter, so say what it is once and stop burning the wall clock.
      if (/HTTP 401|could not be authenticated/i.test(message)) {
        console.log('    The key was rejected, so every mode below would fail the same way.');
        console.log('    Photoroom API dashboard → API keys → Create API key. Nothing was charged.\n');
        process.exit(2);
      }
    }
  }

  console.log(`\n${good}/${modes.length} came back as a picture. Open them — a mode can succeed and still have ignored what it was asked.\n`);
  process.exit(good === modes.length ? 0 : 1);
}

void main();
