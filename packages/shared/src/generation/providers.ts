/**
 * The contract every AI provider is held to.
 *
 * Business logic never calls a provider. It asks the router for a capability;
 * the router picks an adapter from config rows; the adapter speaks the
 * vendor's dialect and translates the answer back into these shapes. Nothing
 * outside an adapter imports a vendor SDK, and nothing outside an adapter
 * ever sees a vendor's error message.
 *
 * WHY ERRORS ARE A TAXONOMY
 * -------------------------
 * A vendor says "429 slow down", another says "quota exceeded", a third
 * returns 200 with {"status":"rejected","reason":"unsafe"}. The pipeline
 * cannot make a retry, refund or fallback decision from any of those. So
 * each adapter maps its failures onto these kinds, and the kinds — not
 * the vendor's words — decide what happens next and what the customer is
 * told. The vendor's words are kept, logged, and shown only to operators.
 */

import type { Capability, ExportSize, GenerationOutput } from './capabilities';

export const PROVIDER_ERROR_KINDS = [
  'RETRYABLE', // transient: timeout, 5xx, network — try again, then fall back
  'RATE_LIMITED', // back off and try again; the breaker counts these
  'CONTENT_REJECTED', // the vendor's policy refused the input — no retry, refund, explain
  'REQUEST_REJECTED', // the vendor rejected this request/media — no cross-provider fallback or second paid call
  'SUBMISSION_UNKNOWN', // a paid request may have been accepted but no durable job id exists — fail closed, refund, reconcile
  'INVALID_INPUT', // caught locally: our adapter request/invariant was malformed — refund and alert
  'PROVIDER_DOWN', // auth failure, 404 on the model, sustained 5xx — open the breaker
  'LOW_QUALITY', // the vendor answered, but what it made failed our own check — refund, no retry beyond the pipeline's own
] as const;
export type ProviderErrorKind = (typeof PROVIDER_ERROR_KINDS)[number];

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    /** Operator-facing. Never rendered to a customer. */
    message: string,
    readonly providerKey: string,
    readonly meta: { status?: number; providerJobId?: string; submissionState?: 'NOT_STARTED' | 'ACCEPTED' | 'TERMINAL'; raw?: unknown } = {},
  ) {
    super(message);
    this.name = 'ProviderError';
  }

  /** Whether the pipeline may try again with the same or another provider. */
  get retryable(): boolean {
    return this.kind === 'RETRYABLE' || this.kind === 'RATE_LIMITED' || this.kind === 'PROVIDER_DOWN';
  }
}

/** What the customer is told for each kind. Short, honest, and about what happens next. */
export const CUSTOMER_MESSAGE: Record<ProviderErrorKind, string> = {
  RETRYABLE: 'That took longer than it should have. Your credits are back — try again in a moment.',
  RATE_LIMITED: 'We are busier than usual. Your credits are back — try again in a minute.',
  CONTENT_REJECTED: 'That image or text could not be used. Your credits are back. Try a different photo or wording.',
  REQUEST_REJECTED: 'That file or request could not be used. Your credits are back. Check the file and settings, then try again.',
  SUBMISSION_UNKNOWN:
    'We could not safely confirm that job after a connection interruption. Your credits are back; support can reconcile it without charging twice.',
  INVALID_INPUT: 'Something about that request did not work. Your credits are back and we have been notified.',
  PROVIDER_DOWN: 'This tool is briefly unavailable. Your credits are back — try again shortly.',
  LOW_QUALITY: 'We could not make a version that kept your product looking right. Your credits are back — try a clearer photo or a simpler scene.',
};

/** A file the adapter can read: a short-lived signed URL, or bytes when the vendor needs an upload. */
export interface ProviderFile {
  /** Stable storage identity. Unlike a signed URL, this survives host/key rotation. */
  key?: string;
  url: string;
  mime: string;
  bytes?: number;
}

export interface ProviderInput<P = Record<string, unknown>> {
  generationId: string;
  workspaceId: string;
  capability: Capability;
  params: P;
  /** Inputs already resolved to something the vendor can fetch, keyed by param name (sourceKey → source). */
  files: Record<string, ProviderFile>;
  /** Model-specific settings from the ProviderModel row's config column. */
  config: Record<string, unknown>;
  /**
   * For TEXT_GENERATE only: the fully built request. The PIPELINE writes the
   * prompt — it knows the brand kit, the workspace profile and the schema —
   * and every text adapter renders this one shape into its vendor's dialect.
   * An adapter never composes a prompt of its own.
   */
  prompt?: LlmRequest;
}

export interface LlmRequest {
  system: string;
  /** Text and images in order. Images are fetched by the adapter and inlined as the vendor requires. */
  parts: Array<{ text: string } | { imageUrl: string; mime: string }>;
  /** When set, the adapter asks for JSON conforming to this schema and the pipeline validates it. */
  jsonSchema?: Record<string, unknown>;
  maxTokens?: number;
  temperature?: number;
}

export interface ProviderOpts {
  /** Hard ceiling, in ms, on how long the adapter may wait for the vendor. */
  timeoutMs: number;
  /** Refresh the generation's heartbeat and narrate progress while waiting. */
  onProgress?: (detail: string, progress?: number) => void;
  signal?: AbortSignal;
  /**
   * Resume an async vendor job that was durably recorded before this worker
   * disappeared. Adapters must skip their create/submit request when set.
   */
  resume?: { providerJobId: string; data?: Record<string, unknown> };
  /**
   * Durability barrier immediately after an async create response. The
   * adapter must await this before it polls or downloads anything.
   */
  onSubmitted?: (providerJobId: string, data?: Record<string, unknown>) => Promise<void>;
  /** The vendor has definitively settled the recorded job. */
  onSettled?: (outcome: 'SUCCEEDED' | 'FAILED') => Promise<void>;
}

/** A produced file the pipeline must copy into our storage. */
export interface ProviderArtifact {
  /** Where the vendor left it. Fetched immediately; vendor URLs expire. */
  url?: string;
  /** Or the bytes directly, for vendors that return them inline. */
  bytes?: Uint8Array;
  mime: string;
  role: GenerationOutput['role'];
  width?: number;
  height?: number;
  durationMs?: number;
  /** For TEXT_GENERATE: structured content instead of a file. */
  text?: unknown;
  /** For size variants the pipeline cut: which export size. */
  size?: ExportSize;
}

export interface ProviderResult {
  providerKey: string;
  providerJobId?: string;
  artifacts: ProviderArtifact[];
  /** What the vendor charged us, in minor units of the billing currency, when known. */
  costMinor?: number;
  /** Timing and vendor metadata worth keeping on the row for support. */
  meta?: Record<string, unknown>;
}

export interface CostEstimate {
  /** Minor units of the billing currency. */
  costMinor: number;
  /** Rough wall-clock the studio can set expectations from. */
  expectedMs: number;
}

/**
 * One vendor, one model, one adapter instance. `key` matches the
 * ProviderModel row ("fal:seedream-4.5") so the router can pair them.
 */
export interface GenerationProvider {
  readonly key: string;
  readonly capabilities: readonly Capability[];
  supports(capability: Capability): boolean;
  estimateCost(input: ProviderInput): CostEstimate;
  generate(input: ProviderInput, opts: ProviderOpts): Promise<ProviderResult>;
}
