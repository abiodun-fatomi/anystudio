import { describe, expect, it } from 'vitest';
import { isProductionDeployment } from './environment';

describe('isProductionDeployment', () => {
  it('uses an explicit production APP_ENV', () => {
    expect(isProductionDeployment({ APP_ENV: ' production ', NODE_ENV: 'development' })).toBe(true);
  });

  it.each(['dev', 'development', 'staging', 'local', 'test'])('lets explicit APP_ENV=%s override a production build', (APP_ENV) => {
    expect(isProductionDeployment({ APP_ENV, NODE_ENV: 'production' })).toBe(false);
  });

  it('fails closed when APP_ENV is misspelled', () => {
    expect(isProductionDeployment({ APP_ENV: 'prodution', NODE_ENV: 'development' })).toBe(true);
  });

  it.each([undefined, '', '   '])('fails closed for NODE_ENV=production when APP_ENV is %j', (APP_ENV) => {
    expect(isProductionDeployment({ APP_ENV, NODE_ENV: 'production' })).toBe(true);
  });

  it('is not production when neither signal says production', () => {
    expect(isProductionDeployment({ NODE_ENV: 'development' })).toBe(false);
  });
});
