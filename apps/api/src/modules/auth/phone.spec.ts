import { describe, expect, it } from 'vitest';
import { RegistrationService } from './registration.service';

describe('phone normalisation', () => {
  it('accepts E.164 from anywhere, reads a local number in its country, still fixes a bare Nigerian number, and refuses nonsense', () => {
    expect(RegistrationService.normalisePhone('+234 801 234 5678')).toBe('+2348012345678');
    expect(RegistrationService.normalisePhone('+254712345678')).toBe('+254712345678');
    expect(RegistrationService.normalisePhone('+44 7400 123456')).toBe('+447400123456');
    expect(RegistrationService.normalisePhone('(201) 555-0123', 'US')).toBe('+12015550123');
    expect(RegistrationService.normalisePhone('0712 345678', 'KE')).toBe('+254712345678');
    expect(RegistrationService.normalisePhone('024 123 4567', 'gh')).toBe('+233241234567');
    expect(RegistrationService.normalisePhone('0801 234 5678')).toBe('+2348012345678');
    expect(() => RegistrationService.normalisePhone('12345')).toThrow();
    expect(() => RegistrationService.normalisePhone('+999 1 2')).toThrow();
    expect(() => RegistrationService.normalisePhone('hello')).toThrow();
  });
});
