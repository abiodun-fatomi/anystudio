import { describe, expect, it } from 'vitest';
import { Helpers } from './helpers';

describe('Helpers', () => {
  it('builds the response envelope', () => {
    expect(Helpers.successResponse(201, 'Created', { id: 1 })).toEqual({ status: 201, message: 'Created', data: { id: 1 } });
  });

  it('recognises an envelope so it is never wrapped twice', () => {
    expect(Helpers.isEnvelope(Helpers.successResponse(200, 'OK', null))).toBe(true);
    expect(Helpers.isEnvelope({ status: 'ok' })).toBe(false);
    expect(Helpers.isEnvelope(null)).toBe(false);
  });

  it('takes the first name and never greets an empty string', () => {
    expect(Helpers.firstName('Adaeze Okonkwo')).toBe('Adaeze');
    expect(Helpers.firstName('   ')).toBeNull();
    expect(Helpers.firstName(null)).toBeNull();
  });
});
