/**
 * Everything shared between the API, the worker and the web apps.
 *
 * This package is why the repo is a monorepo. The credit costs the UI quotes
 * and the credit costs the API charges must be the same values, and the only
 * way to guarantee that is for both to import them from one place.
 */

export * from './auth/surfaces';
export * from './onboarding/tours';
