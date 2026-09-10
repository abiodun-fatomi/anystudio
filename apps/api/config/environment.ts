export interface DeploymentEnvironment {
  APP_ENV?: string;
  NODE_ENV?: string;
}

/**
 * Whether this process is serving a production deployment.
 *
 * APP_ENV is the explicit deployment setting and therefore wins whenever it
 * is present. NODE_ENV is the fail-closed fallback for production builds
 * whose deployment metadata was accidentally omitted.
 */
export function isProductionDeployment(env: DeploymentEnvironment = process.env): boolean {
  const appEnv = env.APP_ENV?.trim().toLowerCase();
  if (appEnv === 'production') return true;
  if (appEnv === 'dev' || appEnv === 'development' || appEnv === 'staging' || appEnv === 'local' || appEnv === 'test') return false;
  // A typo in deployment metadata must not enable sandbox credentials,
  // developer keys, Swagger, or customer-facing provider failure details.
  if (appEnv) return true;
  return env.NODE_ENV?.trim().toLowerCase() === 'production';
}
