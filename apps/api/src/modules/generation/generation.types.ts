/**
 * What a generation is, in and out of the service.
 *
 * The DTO (generation.dto.ts) is the HTTP contract. These are the types the
 * service speaks in — the worker calls the same methods without going near
 * HTTP, and it should not have to construct a DTO to do it.
 */

import type { Generation, GenerationKind } from '@prisma/client';
import type { Capability, GenerationOutput, ProviderErrorKind } from '@anystudio/shared';

/** Everything needed to reserve credits and write the row. */
export interface GenerationRequest {
  workspaceId: string;
  requestedById: string;
  /** What is being asked for. Decides the queue, the router's candidates and the pipeline. */
  capability: Capability;
  /**
   * The capability's parameters, already validated against its schema in
   * packages/shared. Storage keys, never URLs — see the schema comments.
   */
  params: Record<string, unknown>;
  /**
   * Supplied by the client, unique per workspace. A retried request with the
   * same key returns the existing row instead of creating and charging a
   * second one. Optional only for rows the system creates for itself.
   */
  clientKey?: string;
  /** A CreditCost code. Defaults to the capability's usual code. */
  costCode?: string;
  /** For shots of a plan: the PARENT row. */
  parentId?: string;
  kind?: GenerationKind;
}

/** How a generation finished, from the worker's point of view. */
export interface GenerationOutcome {
  providerKey?: string;
  providerJobId?: string;
  /** What was produced, as storage keys and small inline text. */
  outputs?: GenerationOutput[];
  /** Operator-facing. Never rendered to the customer. */
  failureReason?: string;
  /** Which of the five kinds it failed with; picks the customer's sentence. */
  failureKind?: ProviderErrorKind | 'TIMEOUT' | 'INTERNAL';
  /** What the vendor charged us, in minor units, when known. */
  providerCostMinor?: number;
}

/** A generation as the API returns it: the row plus the sentence the customer should read. */
export interface GenerationView {
  generation: Generation;
  /** Set on FAILED rows: what happened and what to do, never the vendor's words. */
  message?: string;
}

/**
 * A generation plus the balance after it, which is what every caller wants
 * next: the UI shows the new balance, the worker logs it, support reads it.
 */
export interface GenerationResult {
  generation: Generation;
  balance: number;
}

/** The states a generation can no longer leave. */
export const TERMINAL_STATUSES = ['SUCCEEDED', 'FAILED', 'CANCELLED'] as const;

/**
 * How long a generation may go without a heartbeat before the sweeper calls it
 * dead and refunds it.
 *
 * Generous on purpose: a reel can legitimately take minutes at the provider,
 * and refunding work that is still running is worse than refunding late — the
 * customer gets their credits back and then the outputs arrive, having been
 * paid for once. The worker refreshes `heartbeatAt` far more often than this.
 */
export const STALE_AFTER_MS = 15 * 60 * 1000;
