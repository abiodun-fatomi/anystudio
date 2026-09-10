/**
 * Small, dependency-free helpers used across modules.
 */
import { HttpStatus } from '@nestjs/common';
import type { ApiEnvelope } from '../../config/globals/interface';

export class Helpers {
  /**
   * The response envelope.
   *
   * Every successful response has the same three fields so a client can
   * handle "did it work, what happened, what came back" without knowing the
   * endpoint. Services return this from their public methods; the envelope
   * interceptor leaves it alone when it is already there and wraps anything
   * else with a generic message.
   */
  static successResponse<T>(status: number = HttpStatus.OK, message: string, data: T): ApiEnvelope<T> {
    return { status, message, data };
  }

  /** True when a value already looks like an envelope, so it is not wrapped twice. */
  static isEnvelope(value: unknown): value is ApiEnvelope<unknown> {
    return (
      typeof value === 'object' &&
      value !== null &&
      typeof (value as ApiEnvelope<unknown>).status === 'number' &&
      typeof (value as ApiEnvelope<unknown>).message === 'string' &&
      'data' in (value as object)
    );
  }

  /** First name for a greeting, or null. "Adaeze Okonkwo" → "Adaeze". */
  static firstName(name: string | null | undefined): string | null {
    const first = name?.trim().split(/\s+/)[0];
    return first || null;
  }
}
