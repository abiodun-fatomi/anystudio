/**
 * Google — Gemini image models, Gemini text, and Veo.
 *
 * TWO DOORS, ONE ADAPTER
 * ----------------------
 * The same models are reachable through the Gemini Developer API (an API
 * key, quick to start) and through Vertex AI (a service account, and the
 * only door with Google's generative-AI indemnification on GA models). The
 * adapter takes whichever credential is configured and prefers Vertex when
 * both are; the request bodies are identical, only the URL and the auth
 * header differ. Start on the key; move to Vertex before selling to an
 * ORGANIZATION customer whose procurement asks about indemnity.
 *
 * Model names live on the ProviderModel row's config, not here.
 */

import { createSign } from 'node:crypto';
import { ProviderError, type Capability, type ProviderArtifact, type ProviderInput, type ProviderOpts, type ProviderResult } from '@anystudio/shared';
import { BaseProvider } from './base';
import { fetchBytes, http, pick, poll } from './http';

export interface GoogleCredentials {
  apiKey?: string;
  /** The service-account JSON, as a string, for Vertex. */
  saJson?: string;
  project?: string;
  location?: string;
}

const KNOWN: Record<string, { capabilities: Capability[]; model: string }> = {
  'vertex:gemini-3-pro-image': { capabilities: ['IMAGE_EDIT', 'IMAGE_GENERATE', 'BACKGROUND_REPLACE', 'RELIGHT'], model: 'gemini-3-pro-image-preview' },
  'vertex:veo-3.1-fast': { capabilities: ['IMAGE_TO_VIDEO'], model: 'veo-3.1-fast-generate-preview' },
  'google:gemini-2.5-flash-lite': { capabilities: ['TEXT_GENERATE'], model: 'gemini-2.5-flash-lite' },
};

export class GoogleProvider extends BaseProvider {
  static all(creds: GoogleCredentials): GoogleProvider[] {
    const auth = new GoogleAuth(creds);
    return Object.entries(KNOWN).map(([key, k]) => new GoogleProvider(auth, key, k.capabilities, k.model));
  }

  constructor(
    private readonly auth: GoogleAuth,
    key: string,
    capabilities: Capability[],
    private readonly defaultModel: string,
  ) {
    super(key, capabilities);
  }

  async generate(input: ProviderInput, opts: ProviderOpts): Promise<ProviderResult> {
    const model = this.str(input.config, 'model', this.defaultModel);
    switch (input.capability) {
      case 'IMAGE_TO_VIDEO':
        return this.veo(model, input, opts);
      case 'TEXT_GENERATE':
        return this.text(model, input, opts);
      default:
        return this.image(model, input, opts);
    }
  }

  // ---- Gemini image: generateContent with an image response ---------------
  private async image(model: string, input: ProviderInput, opts: ProviderOpts): Promise<ProviderResult> {
    const parts: unknown[] = [];
    let prompt: string;
    let aspect = '1:1';

    switch (input.capability) {
      case 'IMAGE_EDIT': {
        const p = this.params(input, 'IMAGE_EDIT');
        aspect = p.aspect;
        prompt = p.preserveProduct
          ? `${p.prompt}\n\nThe product in the reference image must remain exactly as it is: identical shape, colours, label, text and proportions. Change only the background, surface, lighting and surroundings. Photorealistic, commercial product photography.`
          : p.prompt;
        parts.push(await inline(this.key, this.file(input, 'sourceKey'), opts.timeoutMs));
        break;
      }
      case 'BACKGROUND_REPLACE': {
        const p = this.params(input, 'BACKGROUND_REPLACE');
        aspect = p.aspect;
        prompt = `Replace the background of this product photo with: ${p.prompt}. Keep the product pixel-identical.${p.shadow ? ' Add a natural contact shadow.' : ''}${p.relight ? ' Match the product lighting to the new scene.' : ''}`;
        parts.push(await inline(this.key, this.file(input, 'sourceKey'), opts.timeoutMs));
        break;
      }
      case 'RELIGHT': {
        const p = this.params(input, 'RELIGHT');
        prompt = `Relight this product photo${p.prompt ? `: ${p.prompt}` : ' with soft, even studio lighting and a natural contact shadow'}. Keep the product and background otherwise identical.`;
        parts.push(await inline(this.key, this.file(input, 'sourceKey'), opts.timeoutMs));
        break;
      }
      case 'IMAGE_GENERATE': {
        const p = this.params(input, 'IMAGE_GENERATE');
        aspect = p.aspect;
        prompt = p.style ? `${p.prompt}\n\nStyle: ${p.style}` : p.prompt;
        break;
      }
      default:
        return this.unsupported(input.capability);
    }
    parts.push({ text: prompt });

    opts.onProgress?.('asking Gemini', 20);
    const res = await http<unknown>(this.key, await this.auth.url(`models/${model}:generateContent`), {
      headers: await this.auth.headers(),
      body: { contents: [{ role: 'user', parts }], generationConfig: { responseModalities: ['IMAGE', 'TEXT'], imageConfig: { aspectRatio: aspect } } },
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
    });

    const finish = pick<string>(res.json, 'candidates.0.finishReason');
    const blocked = pick<string>(res.json, 'promptFeedback.blockReason');
    if (blocked || finish === 'SAFETY' || finish === 'PROHIBITED_CONTENT' || finish === 'IMAGE_SAFETY') {
      throw new ProviderError('CONTENT_REJECTED', `${this.key}: refused (${blocked ?? finish})`, this.key, { raw: res.json });
    }
    const candParts = pick<Array<{ inlineData?: { mimeType: string; data: string } }>>(res.json, 'candidates.0.content.parts') ?? [];
    const artifacts: ProviderArtifact[] = candParts
      .filter((p) => p.inlineData)
      .map((p) => ({ bytes: Buffer.from(p.inlineData!.data, 'base64'), mime: p.inlineData!.mimeType, role: 'image' as const }));
    if (artifacts.length === 0) throw new ProviderError('RETRYABLE', `${this.key}: no image in response (finish=${finish})`, this.key, { raw: res.json });
    return { providerKey: this.key, artifacts, meta: { model, usage: pick(res.json, 'usageMetadata') } };
  }

  // ---- Veo: predictLongRunning, then poll the operation ---------------------
  private async veo(model: string, input: ProviderInput, opts: ProviderOpts): Promise<ProviderResult> {
    const p = this.params(input, 'IMAGE_TO_VIDEO');
    const image = await inline(this.key, this.file(input, 'sourceKey'), opts.timeoutMs);
    const headers = await this.auth.headers();
    const started = await http<{ name: string }>(this.key, await this.auth.url(`models/${model}:predictLongRunning`), {
      headers,
      body: {
        instances: [{ prompt: p.motion ? `${p.prompt}. Camera: ${p.motion}` : p.prompt, image: { bytesBase64Encoded: image.inlineData.data, mimeType: image.inlineData.mimeType } }],
        parameters: { aspectRatio: p.aspect === '1:1' ? '9:16' : p.aspect, durationSeconds: p.durationSec, resolution: this.str(input.config, 'resolution', '720p'), personGeneration: 'allow_adult' },
      },
      timeoutMs: 60_000,
      signal: opts.signal,
    });
    const providerJobId = started.json.name;
    opts.onProgress?.('Veo is rendering', 25);

    const done = await poll(
      async () => {
        const op = await http<{ done?: boolean; error?: { message: string; code: number }; response?: unknown }>(this.key, await this.auth.url(providerJobId), { headers, timeoutMs: 20_000, signal: opts.signal });
        if (op.json.error) throw new ProviderError(op.json.error.code === 400 ? 'CONTENT_REJECTED' : 'RETRYABLE', `${this.key}: ${op.json.error.message}`, this.key, { providerJobId });
        return op.json.done ? op.json : null;
      },
      { intervalMs: 8_000, timeoutMs: opts.timeoutMs, signal: opts.signal, onTick: (ms) => opts.onProgress?.(`Veo is rendering (${Math.round(ms / 1000)}s)`, Math.min(80, 25 + ms / 4000)) },
    );

    const uri = pick<string>(done, 'response.generateVideoResponse.generatedSamples.0.video.uri') ?? pick<string>(done, 'response.videos.0.uri');
    const filtered = pick<number>(done, 'response.generateVideoResponse.raiMediaFilteredCount');
    if (!uri) throw new ProviderError(filtered ? 'CONTENT_REJECTED' : 'RETRYABLE', `${this.key}: no video in finished operation`, this.key, { providerJobId, raw: done });
    // The file URL needs the same credential as the API.
    const { bytes, mime } = await fetchBytesWith(this.key, uri, headers, 120_000);
    return { providerKey: this.key, providerJobId, artifacts: [{ bytes, mime: mime.startsWith('video/') ? mime : 'video/mp4', role: 'video', durationMs: p.durationSec * 1000 }], meta: { model } };
  }

  // ---- Gemini text: structured output ---------------------------------------
  private async text(model: string, input: ProviderInput, opts: ProviderOpts): Promise<ProviderResult> {
    const req = input.prompt;
    if (!req) throw new ProviderError('INVALID_INPUT', `${this.key}: TEXT_GENERATE without a prepared prompt`, this.key);
    const parts: unknown[] = [];
    for (const part of req.parts) {
      if ('text' in part) parts.push({ text: part.text });
      else parts.push(await inline(this.key, part.imageUrl, opts.timeoutMs));
    }
    const res = await http<unknown>(this.key, await this.auth.url(`models/${model}:generateContent`), {
      headers: await this.auth.headers(),
      body: {
        systemInstruction: { parts: [{ text: req.system }] },
        contents: [{ role: 'user', parts }],
        generationConfig: {
          temperature: req.temperature ?? 0.7,
          maxOutputTokens: req.maxTokens ?? 2048,
          ...(req.jsonSchema ? { responseMimeType: 'application/json', responseSchema: stripUnsupported(req.jsonSchema) } : {}),
        },
      },
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
    });
    const blocked = pick<string>(res.json, 'promptFeedback.blockReason');
    if (blocked) throw new ProviderError('CONTENT_REJECTED', `${this.key}: refused (${blocked})`, this.key);
    const textOut = (pick<Array<{ text?: string }>>(res.json, 'candidates.0.content.parts') ?? []).map((p) => p.text ?? '').join('');
    if (!textOut) throw new ProviderError('RETRYABLE', `${this.key}: empty completion`, this.key, { raw: res.json });
    return { providerKey: this.key, artifacts: [{ mime: 'application/json', role: 'text', text: req.jsonSchema ? parseJson(this.key, textOut) : textOut }], meta: { model, usage: pick(res.json, 'usageMetadata') } };
  }
}

/** Gemini's schema dialect rejects a few JSON-Schema keywords; drop them rather than fail. */
function stripUnsupported(schema: Record<string, unknown>): Record<string, unknown> {
  const drop = new Set(['$schema', 'additionalProperties', 'default', 'examples', 'title']);
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => !drop.has(k)).map(([k, val]) => [k, walk(val)]));
    }
    return v;
  };
  return walk(schema) as Record<string, unknown>;
}

export function parseJson(providerKey: string, text: string): unknown {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(cleaned);
  } catch {
    throw new ProviderError('RETRYABLE', `${providerKey}: completion was not valid JSON`, providerKey, { raw: text.slice(0, 500) });
  }
}

async function inline(providerKey: string, url: string, timeoutMs: number): Promise<{ inlineData: { mimeType: string; data: string } }> {
  const { bytes, mime } = await fetchBytes(providerKey, url, timeoutMs);
  return { inlineData: { mimeType: mime, data: Buffer.from(bytes).toString('base64') } };
}

async function fetchBytesWith(providerKey: string, url: string, headers: Record<string, string>, timeoutMs: number) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new ProviderError('RETRYABLE', `${providerKey}: could not download video (${res.status})`, providerKey);
  return { bytes: new Uint8Array(await res.arrayBuffer()), mime: res.headers.get('content-type')?.split(';')[0] ?? 'video/mp4' };
}

/**
 * Credentials for either door. A service account is exchanged for a
 * short-lived access token with a self-signed JWT — forty lines of crypto
 * instead of the Google auth library and its dependency tree.
 */
export class GoogleAuth {
  private token: { value: string; exp: number } | null = null;
  private readonly sa: { client_email: string; private_key: string } | null;

  constructor(private readonly creds: GoogleCredentials) {
    this.sa = creds.saJson ? (JSON.parse(creds.saJson) as { client_email: string; private_key: string }) : null;
  }

  get vertex(): boolean {
    return Boolean(this.sa && this.creds.project);
  }

  async url(path: string): Promise<string> {
    if (this.vertex) {
      const loc = this.creds.location ?? 'us-central1';
      const host = loc === 'global' ? 'aiplatform.googleapis.com' : `${loc}-aiplatform.googleapis.com`;
      // Operation names from Vertex already carry the full resource path.
      return path.startsWith('projects/') ? `https://${host}/v1/${path}` : `https://${host}/v1/projects/${this.creds.project}/locations/${loc}/publishers/google/${path}`;
    }
    return `https://generativelanguage.googleapis.com/v1beta/${path}`;
  }

  async headers(): Promise<Record<string, string>> {
    if (this.vertex) return { authorization: `Bearer ${await this.accessToken()}` };
    if (!this.creds.apiKey) throw new ProviderError('PROVIDER_DOWN', 'google: no credential configured', 'google');
    return { 'x-goog-api-key': this.creds.apiKey };
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.exp - 60 > Date.now() / 1000) return this.token.value;
    const now = Math.floor(Date.now() / 1000);
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: this.sa!.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })}`;
    const sig = createSign('RSA-SHA256').update(unsigned).sign(this.sa!.private_key, 'base64url');
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }),
    });
    if (!res.ok) throw new ProviderError('PROVIDER_DOWN', `google: token exchange failed (${res.status})`, 'google');
    const json = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: json.access_token, exp: now + json.expires_in };
    return json.access_token;
  }
}
