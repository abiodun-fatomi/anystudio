import { describe, expect, it, vi } from 'vitest';
import { AuthService } from './auth.service';

describe('registration country precedence', () => {
  it.each([
    ['GB', 'GB'],
    ['NG', 'NG'],
    [undefined, 'NG'],
  ])('confirmed %s overrides dialing country without changing the number', async (billingCountry, expected) => {
    const register = vi.fn().mockResolvedValue({ kind: 'conflict' });
    const service = Object.assign(Object.create(AuthService.prototype), {
      surfaceFromOrigin: () => 'APP',
      registration: { register },
    }) as AuthService;
    await expect(
      service.register(
        {
          name: 'Ada',
          email: 'ada@example.com',
          phone: '+2348012345678',
          password: 'password123',
          billingCountry,
          marketing: { granted: false, wording: 'No marketing' },
        },
        { get: () => undefined } as never,
        {} as never,
      ),
    ).rejects.toThrow();
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ phone: '+2348012345678', country: expected }), expect.anything());
  });
});
