/**
 * Cutouts on our own hardware: BiRefNet under ONNX Runtime, no vendor call
 * and no per-image fee.
 *
 * Background removal is the one paid capability whose model is small enough
 * to sit beside the worker, and it is the step almost every other tool starts
 * with, so it is the one worth owning. A vendor call is a round trip into
 * somebody else's queue; this is a matrix multiply on a box we already rent
 * by the month.
 *
 * TWO PATHS, AND THE FREE ONE IS TRIED FIRST
 * ------------------------------------------
 * A seller who shot against a wall or a light tent has already done the hard
 * part: the background is one colour, and a colour-distance key cuts it out
 * in milliseconds with no model at all. That is a minority of photos but a
 * real one. So the border is measured first, and keyed only when it is
 * genuinely flat AND the result keeps a plausible share of the frame — a key
 * that swallows the product, or keeps everything, is thrown away and the
 * model runs instead. Market tables, wax print, a hand in shot: all model.
 *
 * WHY THE ADAPTER DISAPPEARS WHEN THE WEIGHTS ARE MISSING
 * -------------------------------------------------------
 * The weights are baked into the image, never downloaded at boot: a worker
 * that pulls 200 MB on its first request is a worker that times out on its
 * first request. If the file is absent the adapter is not registered at all,
 * its routing row is simply unroutable, and the request falls through to
 * Photoroom exactly as it does today. A cutout is never worse because our
 * own model is missing; it only costs more.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { ProviderError, type ProviderInput, type ProviderOpts, type ProviderResult } from '@anystudio/shared';
import { logger } from '../../../../config/logger';
import { BaseProvider } from './base';
import { fetchBytes } from './http';

/** Just enough of onnxruntime-node to call it without importing its types. */
interface OrtTensorLike {
  data: Float32Array;
  dims: readonly number[];
}
interface OrtSessionLike {
  inputNames: readonly string[];
  outputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensorLike>>;
}
interface OrtModule {
  InferenceSession: { create(path: string, options?: Record<string, unknown>): Promise<OrtSessionLike> };
  Tensor: new (type: 'float32', data: Float32Array, dims: number[]) => unknown;
}

/**
 * The exports we know how to drive. `logits` is the only one that bites: a
 * BiRefNet export ends before the sigmoid, so its output runs well outside
 * [0,1] and reads as a solid white matte if taken literally.
 */
interface ModelSpec {
  file: string;
  size: number;
  mean: readonly [number, number, number];
  std: readonly [number, number, number];
  logits: boolean;
}

const MODELS: Record<string, ModelSpec> = {
  'birefnet-lite': { file: 'birefnet-lite.onnx', size: 1024, mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225], logits: true },
  isnet: { file: 'isnet-general-use.onnx', size: 1024, mean: [0.5, 0.5, 0.5], std: [1, 1, 1], logits: false },
  u2netp: { file: 'u2netp.onnx', size: 320, mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225], logits: false },
};

const DEFAULT_MODEL = 'birefnet-lite';
const MODEL_DIR = process.env.MATTING_MODEL_DIR ?? '/opt/models';

/** A raw single-plane or interleaved-RGB image, as sharp hands it over. */
export interface RawImage {
  data: Uint8Array;
  width: number;
  height: number;
}

/**
 * The mean colour of the frame's border and how far the border strays from
 * it. A light tent gives a spread of a few units; a market stall gives
 * dozens.
 */
export function borderColour(img: RawImage, band = 8): { colour: [number, number, number]; spread: number } {
  const { data, width, height } = img;
  const b = Math.max(1, Math.min(band, Math.floor(Math.min(width, height) / 8)));
  let r = 0;
  let g = 0;
  let bl = 0;
  let n = 0;
  const visit = (x: number, y: number): void => {
    const i = (y * width + x) * 3;
    r += data[i] ?? 0;
    g += data[i + 1] ?? 0;
    bl += data[i + 2] ?? 0;
    n += 1;
  };
  for (let y = 0; y < height; y += 1) {
    const edgeRow = y < b || y >= height - b;
    for (let x = 0; x < width; x += 1) {
      if (edgeRow || x < b || x >= width - b) visit(x, y);
    }
  }
  if (n === 0) return { colour: [255, 255, 255], spread: 255 };
  const colour: [number, number, number] = [r / n, g / n, bl / n];

  let worst = 0;
  for (let y = 0; y < height; y += 1) {
    const edgeRow = y < b || y >= height - b;
    for (let x = 0; x < width; x += 1) {
      if (!(edgeRow || x < b || x >= width - b)) continue;
      const i = (y * width + x) * 3;
      const d = Math.hypot((data[i] ?? 0) - colour[0], (data[i + 1] ?? 0) - colour[1], (data[i + 2] ?? 0) - colour[2]);
      if (d > worst) worst = d;
    }
  }
  return { colour, spread: worst };
}

/**
 * Alpha from distance to the backdrop colour: fully transparent at `lo`,
 * fully opaque at `hi`, a straight ramp between so an edge keeps its
 * half-pixels instead of turning into a staircase.
 */
export function keyOut(img: RawImage, colour: readonly [number, number, number], lo: number, hi: number): Uint8Array {
  const { data, width, height } = img;
  const alpha = new Uint8Array(width * height);
  const span = Math.max(1, hi - lo);
  for (let p = 0; p < alpha.length; p += 1) {
    const i = p * 3;
    const d = Math.hypot((data[i] ?? 0) - colour[0], (data[i + 1] ?? 0) - colour[1], (data[i + 2] ?? 0) - colour[2]);
    const v = ((d - lo) / span) * 255;
    alpha[p] = v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v);
  }
  return alpha;
}

/** The share of the frame the matte keeps. Used to sanity-check the key. */
export function coverage(alpha: Uint8Array): number {
  let kept = 0;
  for (const a of alpha) if (a >= 128) kept += 1;
  return alpha.length === 0 ? 0 : kept / alpha.length;
}

export class MattingProvider extends BaseProvider {
  private loaded?: Promise<{ session: OrtSessionLike; spec: ModelSpec; name: string }>;

  constructor(private readonly modelDir: string = MODEL_DIR) {
    super('local:matting', ['BACKGROUND_REMOVE']);
  }

  /**
   * Whether this process can serve at all. Checked once, at registration:
   * an adapter that exists but always fails is worse than one that was never
   * offered, because the router spends a breaker on it first.
   */
  static available(dir: string = MODEL_DIR): boolean {
    return Object.values(MODELS).some((m) => existsSync(join(dir, m.file)));
  }

  async generate(input: ProviderInput, opts: ProviderOpts): Promise<ProviderResult> {
    if (input.capability !== 'BACKGROUND_REMOVE') this.unsupported(input.capability);
    const p = this.params(input, 'BACKGROUND_REMOVE');
    const started = Date.now();

    const { bytes } = await fetchBytes(this.key, this.file(input, 'sourceKey'), Math.max(1, opts.timeoutMs), opts.signal);
    const base = sharp(Buffer.from(bytes), { failOn: 'none' }).rotate().removeAlpha();
    const { data, info } = await base.clone().raw().toBuffer({ resolveWithObject: true });
    const source: RawImage = { data, width: info.width, height: info.height };
    opts.onProgress?.('Cutting out your product', 30);

    let alpha: Uint8Array | undefined;
    let how = 'model';

    if (input.config.fastPath !== false) {
      const flat = this.tryFlatBackdrop(source, input.config);
      if (flat) {
        alpha = flat;
        how = 'flat';
      }
    }
    if (!alpha) alpha = await this.matte(source, input.config, opts);

    const png = await this.compose(source, alpha, p.background);
    const totalMs = Date.now() - started;
    logger.info({ how, width: source.width, height: source.height, totalMs }, 'cutout produced locally');

    return {
      providerKey: this.key,
      costMinor: 0,
      artifacts: [{ bytes: png, mime: 'image/png', role: 'image', width: source.width, height: source.height }],
      meta: { how, model: this.str(input.config, 'model', DEFAULT_MODEL), totalMs },
    };
  }

  /** The no-model path, or undefined when the photo does not qualify for it. */
  private tryFlatBackdrop(source: RawImage, config: Record<string, unknown>): Uint8Array | undefined {
    const tolerance = num(config, 'flatTolerance', 14);
    const { colour, spread } = borderColour(source);
    if (spread > tolerance) return undefined;
    const alpha = keyOut(source, colour, num(config, 'keyLow', 20), num(config, 'keyHigh', 52));
    const kept = coverage(alpha);
    // A key that keeps almost nothing ate the product; one that keeps almost
    // everything found no background. Either way the model does it properly.
    if (kept < 0.02 || kept > 0.97) return undefined;
    return alpha;
  }

  /** The model path: squash to the model's square, run, stretch back. */
  private async matte(source: RawImage, config: Record<string, unknown>, opts: ProviderOpts): Promise<Uint8Array> {
    const { session, spec } = await this.ensure(config);
    const size = Math.max(64, Math.round(num(config, 'inputSize', spec.size)));

    const square = await sharp(Buffer.from(source.data), { raw: { width: source.width, height: source.height, channels: 3 } })
      .resize(size, size, { fit: 'fill', kernel: 'cubic' })
      .raw()
      .toBuffer();

    const plane = size * size;
    const tensor = new Float32Array(plane * 3);
    for (let i = 0; i < plane; i += 1) {
      tensor[i] = ((square[i * 3] ?? 0) / 255 - spec.mean[0]) / spec.std[0];
      tensor[plane + i] = ((square[i * 3 + 1] ?? 0) / 255 - spec.mean[1]) / spec.std[1];
      tensor[plane * 2 + i] = ((square[i * 3 + 2] ?? 0) / 255 - spec.mean[2]) / spec.std[2];
    }

    const ort = await loadOrt();
    const feeds: Record<string, unknown> = { [session.inputNames[0] ?? 'input_image']: new ort.Tensor('float32', tensor, [1, 3, size, size]) };
    const ran = Date.now();
    const outputs = await session.run(feeds);
    if (opts.signal?.aborted) throw new ProviderError('RETRYABLE', `${this.key}: aborted during inference`, this.key);

    const out = pickMatte(outputs, session.outputNames, plane);
    const mask = new Uint8Array(plane);
    for (let i = 0; i < plane; i += 1) {
      const raw = out[i] ?? 0;
      const v = spec.logits ? 1 / (1 + Math.exp(-raw)) : raw;
      mask[i] = v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255);
    }
    logger.info({ inferenceMs: Date.now() - ran, size }, 'matte inferred');

    // Back to full resolution, then a gentle contrast stretch: a soft matte
    // leaves a grey haze where the old background was, which shows the moment
    // the cutout lands on a white storefront tile.
    const full = await sharp(Buffer.from(mask), { raw: { width: size, height: size, channels: 1 } })
      .resize(source.width, source.height, { fit: 'fill', kernel: 'cubic' })
      .linear(num(config, 'alphaGain', 1.25), -255 * num(config, 'alphaLift', 0.1))
      .raw()
      .toBuffer();
    return new Uint8Array(full.buffer, full.byteOffset, full.byteLength);
  }

  private async compose(source: RawImage, alpha: Uint8Array, background: string): Promise<Uint8Array> {
    const image = sharp(Buffer.from(source.data), { raw: { width: source.width, height: source.height, channels: 3 } }).joinChannel(Buffer.from(alpha), {
      raw: { width: source.width, height: source.height, channels: 1 },
    });
    const flattened = background === 'transparent' ? image : image.flatten({ background });
    const png = await flattened.png({ compressionLevel: 6 }).toBuffer();
    return new Uint8Array(png.buffer, png.byteOffset, png.byteLength);
  }

  /** One session per process, created on first use and kept warm after. */
  private ensure(config: Record<string, unknown>): Promise<{ session: OrtSessionLike; spec: ModelSpec; name: string }> {
    if (this.loaded) return this.loaded;
    const name = this.str(config, 'model', DEFAULT_MODEL);
    const spec = MODELS[name];
    if (!spec) throw new ProviderError('INVALID_INPUT', `${this.key}: unknown model "${name}"`, this.key);
    const path = join(this.modelDir, spec.file);
    if (!existsSync(path)) throw new ProviderError('PROVIDER_DOWN', `${this.key}: weights not present at ${path}`, this.key);

    const loading = (async () => {
      const ort = await loadOrt();
      const at = Date.now();
      const session = await ort.InferenceSession.create(path, {
        executionProviders: ['cpu'],
        graphOptimizationLevel: 'all',
        executionMode: 'sequential',
        intraOpNumThreads: Math.max(1, Number(process.env.MATTING_THREADS ?? 2)),
        logSeverityLevel: 3,
      });
      logger.info({ model: name, path, loadMs: Date.now() - at }, 'matting session ready');
      return { session, spec, name };
    })();
    // A failed load must not be cached, or one bad start disables the adapter
    // for the life of the process.
    this.loaded = loading.catch((err: unknown) => {
      this.loaded = undefined;
      throw new ProviderError('PROVIDER_DOWN', `${this.key}: could not load ${path}: ${String(err)}`, this.key);
    });
    return this.loaded;
  }
}

let ortModule: Promise<OrtModule> | undefined;

/**
 * Loaded on demand, never at import: the API process registers the same
 * adapters as the worker and must not pay to map a native runtime it will
 * never call.
 */
async function loadOrt(): Promise<OrtModule> {
  ortModule ??= import('onnxruntime-node').then((m) => m as unknown as OrtModule);
  return ortModule;
}

/**
 * The matte among the outputs. BiRefNet's final map is its last output;
 * u2net-family exports put their best one first. Both are the only output
 * whose element count matches the square, so match on that and fall back to
 * the documented order.
 */
function pickMatte(outputs: Record<string, OrtTensorLike>, names: readonly string[], plane: number): Float32Array {
  const ordered = names.map((n) => outputs[n]).filter((t): t is OrtTensorLike => Boolean(t));
  const sized = ordered.filter((t) => t.data.length === plane);
  const chosen = sized.at(-1) ?? ordered.at(-1);
  if (!chosen) throw new ProviderError('RETRYABLE', 'local:matting: model returned no output', 'local:matting');
  return chosen.data;
}

function num(config: Record<string, unknown>, name: string, fallback: number): number {
  const v = Number(config[name]);
  return Number.isFinite(v) ? v : fallback;
}
