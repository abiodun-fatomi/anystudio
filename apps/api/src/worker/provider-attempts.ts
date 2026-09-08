/**
 * Durable journal for external provider calls.
 *
 * There are two different crash windows to handle:
 *
 *  1. the vendor returned a job id and the worker later disappeared. That is
 *     resumable: SUBMITTED holds the id and the adapter polls the same job.
 *  2. the POST may have reached the vendor but the worker died before it
 *     received/persisted the id. That is deliberately not guessed at:
 *     SUBMITTING fails closed and the customer's credits are refunded.
 *
 * The operation key is stable across worker attempts but distinguishes two
 * intentional identical calls in one deterministic pipeline replay. Signed
 * URL query strings are excluded because they change every time inputs are
 * resolved.
 */

import { createHash } from 'node:crypto';
import { Prisma, PrismaClient, type ProviderAttempt } from '@prisma/client';
import { ProviderError, type ProviderInput } from '@anystudio/shared';
import type { ProviderRegistry } from '../modules/provider/provider.registry';
import type { RouteCandidate } from '../modules/provider/provider.router';

const OPEN = ['SUBMITTING', 'SUBMITTED', 'SUCCEEDED'] as const;

export interface ProviderAttemptHandle {
  row: ProviderAttempt;
  resume?: { providerJobId: string; data?: Record<string, unknown> };
}

export class ProviderAttemptJournal {
  private readonly ordinals = new Map<string, number>();

  constructor(
    private readonly db: PrismaClient,
    private readonly generationId: string,
    private readonly generationAttempt: number,
  ) {}

  /** Same logical provider call gets the same key when a pipeline is replayed. */
  nextOperation(input: Omit<ProviderInput, 'config'>): string {
    const signature = providerOperationSignature(input);
    const ordinal = this.ordinals.get(signature) ?? 0;
    this.ordinals.set(signature, ordinal + 1);
    return `${signature}:${ordinal}`;
  }

  /**
   * An open attempt outranks today's router decision. A breaker opening while
   * a job renders must not cause a second vendor to receive the same request.
   */
  async outstanding(operationKey: string, registry: ProviderRegistry, candidates: RouteCandidate[]): Promise<RouteCandidate | null> {
    const rows = await this.db.providerAttempt.findMany({
      where: { generationId: this.generationId, operationKey, status: { in: [...OPEN] } },
      orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
      take: 2,
    });
    if (rows.length === 0) return null;
    if (rows.length > 1) {
      throw new ProviderError('SUBMISSION_UNKNOWN', `multiple unresolved provider submissions exist for operation ${operationKey}`, 'runner', {
        raw: { attemptIds: rows.map((row) => row.id) },
      });
    }
    const attempt = rows[0]!;
    if (attempt.status === 'SUBMITTING' || !attempt.providerJobId) throw unknownSubmission(attempt);

    const routed = candidates.find((candidate) => candidate.row.key === attempt.providerKey && candidate.row.capability === attempt.capability);
    if (routed) return routed;

    // Resume even when a circuit breaker or an operator disabled new traffic.
    // The adapter still has to be registered in this process and the original
    // ProviderModel row must still exist; otherwise no safe dialect/config is
    // available and this generation is refunded rather than re-submitted.
    const [row, provider] = await Promise.all([
      this.db.providerModel.findUnique({ where: { key_capability: { key: attempt.providerKey, capability: attempt.capability } } }),
      Promise.resolve(registry.get(attempt.providerKey)),
    ]);
    if (!row || !provider || !provider.supports(attempt.capability)) {
      throw new ProviderError(
        'SUBMISSION_UNKNOWN',
        `${attempt.providerKey}: accepted job ${attempt.providerJobId} cannot be resumed because its adapter or model row is unavailable`,
        attempt.providerKey,
        { providerJobId: attempt.providerJobId },
      );
    }
    return { row, provider };
  }

  /** Reserve the crash boundary before the adapter can issue an external POST. */
  async begin(operationKey: string, candidate: RouteCandidate): Promise<ProviderAttemptHandle> {
    const latest = await this.db.providerAttempt.findFirst({
      where: { generationId: this.generationId, operationKey, providerKey: candidate.row.key },
      orderBy: { submissionNo: 'desc' },
    });
    if (latest && latest.status !== 'FAILED') {
      if (latest.status === 'SUBMITTING' || !latest.providerJobId) throw unknownSubmission(latest);
      return { row: latest, resume: resumeOf(latest) };
    }

    const row = await this.db.providerAttempt.create({
      data: {
        generationId: this.generationId,
        operationKey,
        providerKey: candidate.row.key,
        capability: candidate.row.capability,
        submissionNo: (latest?.submissionNo ?? 0) + 1,
        generationAttempt: this.generationAttempt,
        status: 'SUBMITTING',
      },
    });
    return { row };
  }

  /** Persist the vendor id and generation reconciliation fields atomically. */
  async submitted(attemptId: string, providerKey: string, providerJobId: string, data?: Record<string, unknown>): Promise<void> {
    try {
      await this.db.$transaction(async (tx) => {
        const { count } = await tx.providerAttempt.updateMany({
          where: { id: attemptId, generationId: this.generationId, status: 'SUBMITTING' },
          data: {
            status: 'SUBMITTED',
            providerJobId,
            submittedAt: new Date(),
            ...(data ? { resumeData: data as Prisma.InputJsonObject } : {}),
          },
        });
        if (count !== 1) throw new Error(`provider attempt ${attemptId} was not SUBMITTING`);
        await tx.generation.updateMany({
          where: { id: this.generationId, status: 'RUNNING' },
          data: { providerKey, providerJobId },
        });
      });
    } catch (err) {
      throw new ProviderError(
        'SUBMISSION_UNKNOWN',
        `${providerKey}: accepted job ${providerJobId}, but its id could not be durably recorded: ${err instanceof Error ? err.message : err}`,
        providerKey,
        { providerJobId },
      );
    }
  }

  async settled(attemptId: string, outcome: 'SUCCEEDED' | 'FAILED', error?: ProviderError, costMinor?: number): Promise<void> {
    const capturedCost = typeof costMinor === 'number' && Number.isFinite(costMinor) && costMinor >= 0 ? Math.ceil(costMinor) : undefined;
    await this.db.providerAttempt.updateMany({
      where: {
        id: attemptId,
        generationId: this.generationId,
        // A late error must never downgrade a success. Conversely, the
        // runner may fill cost after an adapter's onSettled(SUCCEEDED).
        status: { in: outcome === 'SUCCEEDED' ? ['SUBMITTING', 'SUBMITTED', 'SUCCEEDED'] : ['SUBMITTING', 'SUBMITTED', 'FAILED'] },
        ...(outcome === 'SUCCEEDED' && capturedCost !== undefined ? { costMinor: null } : {}),
      },
      data: {
        status: outcome,
        finishedAt: new Date(),
        ...(outcome === 'SUCCEEDED' && capturedCost !== undefined ? { costMinor: capturedCost } : {}),
        ...(error ? { errorKind: error.kind, errorMessage: error.message.slice(0, 2000) } : {}),
      },
    });
  }

  /** Known spend for this generation, counted once per durable operation row. */
  async totalCostMinor(): Promise<number> {
    const total = await this.db.providerAttempt.aggregate({
      where: { generationId: this.generationId, status: 'SUCCEEDED' },
      _sum: { costMinor: true },
    });
    return total._sum.costMinor ?? 0;
  }

  async read(attemptId: string): Promise<ProviderAttempt | null> {
    return this.db.providerAttempt.findUnique({ where: { id: attemptId } });
  }

  /** A definite pre-submit validation or 4xx response means no job is live. */
  async rejectBeforeAcceptance(attempt: ProviderAttempt, error: ProviderError): Promise<boolean> {
    if (attempt.status !== 'SUBMITTING') return false;
    const definiteStatus = error.meta.status !== undefined && error.meta.status >= 400 && error.meta.status < 500;
    const definite =
      error.meta.submissionState === 'NOT_STARTED' ||
      error.kind === 'INVALID_INPUT' ||
      error.kind === 'CONTENT_REJECTED' ||
      error.kind === 'REQUEST_REJECTED' ||
      definiteStatus;
    if (!definite) return false;
    await this.settled(attempt.id, 'FAILED', error);
    return true;
  }

  /**
   * Decide whether a failed adapter call may safely move on. This throws for
   * every unresolved/ambiguous state; returning means the vendor definitively
   * rejected or failed the job and a new candidate cannot duplicate it.
   */
  async guardFailure(attempt: ProviderAttempt, error: ProviderError): Promise<void> {
    const current = await this.read(attempt.id);
    if (!current) throw new ProviderError('SUBMISSION_UNKNOWN', `provider attempt ${attempt.id} disappeared`, error.providerKey, error.meta);
    if (current.status === 'FAILED') return;
    if (current.status === 'SUBMITTING') {
      if (await this.rejectBeforeAcceptance(current, error)) return;
      throw new ProviderError(
        'SUBMISSION_UNKNOWN',
        `${error.providerKey}: its submission may have been accepted before a durable job id was recorded; refusing fallback`,
        error.providerKey,
        { ...error.meta, raw: { cause: error.message, attemptId: current.id } },
      );
    }
    if (current.status === 'SUBMITTED' && error.retryable) {
      throw new ProviderError(error.kind, error.message, error.providerKey, {
        ...error.meta,
        providerJobId: current.providerJobId ?? error.meta.providerJobId,
      });
    }
    throw new ProviderError(
      'SUBMISSION_UNKNOWN',
      current.status === 'SUCCEEDED'
        ? `${error.providerKey}: completed job ${current.providerJobId ?? '(without an id)'} could not be recovered; refusing a duplicate`
        : `${error.providerKey}: accepted job ${current.providerJobId} could not be safely reconciled; refusing fallback`,
      error.providerKey,
      { ...error.meta, providerJobId: current.providerJobId ?? error.meta.providerJobId },
    );
  }
}

export function providerOperationSignature(input: Omit<ProviderInput, 'config'>): string {
  const identityByUrl = new Map(Object.values(input.files).map((file) => [file.url, file.key ?? stableLocation(file.url)]));
  const stable = {
    capability: input.capability,
    params: input.params,
    files: Object.fromEntries(
      Object.entries(input.files)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, file]) => [name, { mime: file.mime, bytes: file.bytes ?? null, location: file.key ?? stableLocation(file.url) }]),
    ),
    prompt: input.prompt
      ? {
          ...input.prompt,
          parts: input.prompt.parts.map((part) =>
            'imageUrl' in part ? { image: identityByUrl.get(part.imageUrl) ?? stableLocation(part.imageUrl), mime: part.mime } : { text: part.text },
          ),
        }
      : null,
  };
  return createHash('sha256').update(canonical(stable)).digest('hex');
}

function resumeOf(row: ProviderAttempt): { providerJobId: string; data?: Record<string, unknown> } {
  const data = row.resumeData && typeof row.resumeData === 'object' && !Array.isArray(row.resumeData) ? (row.resumeData as Record<string, unknown>) : undefined;
  return { providerJobId: row.providerJobId!, ...(data ? { data } : {}) };
}

function unknownSubmission(row: ProviderAttempt): ProviderError {
  return new ProviderError(
    'SUBMISSION_UNKNOWN',
    `${row.providerKey}: an earlier submission may have been accepted before its job id was recorded; refusing to submit duplicate work`,
    row.providerKey,
    { ...(row.providerJobId ? { providerJobId: row.providerJobId } : {}), raw: { attemptId: row.id, operationKey: row.operationKey } },
  );
}

function stableLocation(value: string): string {
  try {
    const url = new URL(value);
    // The host is a delivery detail (R2 endpoint, CDN, path-style toggle), not
    // the input's identity. generationId scopes the journal, so a stable path
    // cannot collide with another customer's operation.
    return url.pathname;
  } catch {
    return value.split(/[?#]/, 1)[0] ?? value;
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  }
  return 'null';
}
