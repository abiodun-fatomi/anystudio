import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { LoginDto, RegisterDto } from './auth.dto';

const errorsFor = async (cls: new () => object, body: unknown) =>
  (await validate(plainToInstance(cls, body))).map((e) => e.property);

describe('auth DTOs', () => {
  it('accepts a complete registration', async () => {
    expect(await errorsFor(RegisterDto, {
      name: 'Ada', email: 'ada@shop.ng', phone: '+2348012345678', password: 'long enough',
      marketing: { granted: false, wording: 'Send me tips' },
    })).toEqual([]);
  });

  it('rejects the fields a browser could get wrong', async () => {
    const bad = await errorsFor(RegisterDto, { name: '', email: 'nope', phone: '1', password: 'short', marketing: { granted: 'yes', wording: '' } });
    expect(bad).toEqual(expect.arrayContaining(['name', 'email', 'phone', 'password', 'marketing']));
  });

  it('requires both halves of a login', async () => {
    expect(await errorsFor(LoginDto, { identifier: 'a' })).toEqual(expect.arrayContaining(['identifier', 'password']));
  });
});
