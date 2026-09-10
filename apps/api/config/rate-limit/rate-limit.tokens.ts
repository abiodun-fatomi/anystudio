/**
 * The injection token and the store interface, in their own file so the guard
 * and the module can both import them without importing each other.
 */
export const RATE_LIMIT_STORE = Symbol('RATE_LIMIT_STORE');
export type { RateLimitStore, RateVerdict } from './rate-limit.store';
