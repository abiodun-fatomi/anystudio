/**
 * Request-scoped types shared by controllers, guards and services.
 *
 * `Actor` is what a request is allowed to do, assembled once per request by
 * the auth guard from the session, the staff grant and the workspace
 * memberships. It is never built anywhere else and never trusted from input.
 */
import type { Request } from 'express';
import type { Actor, SessionActor } from '../../src/modules/auth/policy';

export type { Actor, SessionActor };

/** An Express request after the auth guard has run. */
export interface AuthenticatedRequest extends Request {
  actor: SessionActor;
}

/** The envelope every 2xx response is wrapped in (see responseEnvelope.ts). */
export interface ApiEnvelope<T> {
  status: number;
  message: string;
  data: T;
}
