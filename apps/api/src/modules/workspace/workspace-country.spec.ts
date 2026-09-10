import { describe, expect, it, vi } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { WorkspaceService } from './workspace.service';
import { WorkspaceCreateDto } from './workspace.dto';
import { RegisterDto } from '../auth/auth.dto';

describe('confirmed billing country', () => {
  it.each([
    ['NG', 'NGN'],
    ['GB', 'GBP'],
    ['US', 'USD'],
    ['KE', 'USD'],
  ])('prices %s independently of inherited currency', async (billingCountry, currency) => {
    const create = vi.fn(async ({ data }) => data);
    const db = {
      workspaceMember: { count: vi.fn().mockResolvedValue(1), findFirst: vi.fn().mockResolvedValue({ workspace: { currency: 'NGN', region: 'ng' } }) },
      workspace: { create },
    };
    const service = new WorkspaceService(db as never, {} as never);
    await service.create('user', { name: 'Company', type: 'ORGANIZATION', billingCountry }, { get: () => undefined } as never);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ currency, profile: { billingCountry }, region: 'ng' }) }));
  });

  it('uses USD for a first workspace with unknown country', async () => {
    const create = vi.fn(async ({ data }) => data);
    const db = { workspaceMember: { count: vi.fn().mockResolvedValue(0), findFirst: vi.fn().mockResolvedValue(null) }, workspace: { create } };
    await new WorkspaceService(db as never, {} as never).create('user', { name: 'Studio', type: 'BUSINESS' }, { get: () => undefined } as never);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ currency: 'USD' }) }));
  });

  it.each([WorkspaceCreateDto, RegisterDto])('rejects invalid billing country on the API', async (dto) => {
    const errors = await validate(plainToInstance(dto, { billingCountry: 'ZZ' }));
    expect(errors.map((e) => e.property)).toContain('billingCountry');
  });
});
