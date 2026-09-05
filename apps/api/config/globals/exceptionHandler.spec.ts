import { BadRequestException, type ArgumentsHost } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { GlobalExceptionFilter } from './exceptionHandler';
import { NotFoundError } from './errors';

function host(requestId = 'req_1') {
  const json = vi.fn();
  const res = { status: vi.fn(() => ({ json })), setHeader: vi.fn() };
  const req = { requestId, path: '/x', method: 'GET' };
  return { host: { switchToHttp: () => ({ getResponse: () => res, getRequest: () => req }) } as unknown as ArgumentsHost, res, json };
}

describe('GlobalExceptionFilter', () => {
  it('turns an AppError into the error envelope with the request id', () => {
    const h = host();
    new GlobalExceptionFilter().catch(new NotFoundError('wallet'), h.host);
    expect(h.res.status).toHaveBeenCalledWith(404);
    expect(h.json.mock.calls[0]?.[0]).toMatchObject({ status: 404, error: 'not_found', data: null, requestId: 'req_1' });
  });

  it('lists each failed field from the validation pipe', () => {
    const h = host();
    new GlobalExceptionFilter().catch(new BadRequestException(['email must be an email', 'password should not be empty']), h.host);
    expect(h.res.status).toHaveBeenCalledWith(400);
    expect(h.json.mock.calls[0]?.[0]).toMatchObject({ error: 'invalid_input', fields: [{ path: 'email' }, { path: 'password' }] });
  });

  it("never leaks an unexpected error's message", () => {
    const h = host();
    new GlobalExceptionFilter().catch(new Error('ECONNREFUSED 10.0.0.5:5432'), h.host);
    expect(h.res.status).toHaveBeenCalledWith(500);
    expect(JSON.stringify(h.json.mock.calls[0]?.[0])).not.toContain('10.0.0.5');
  });
});
