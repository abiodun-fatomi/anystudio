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
    const create = vi.fn(async ({ data }) => ({ ...data, id: 'ws_1', wallet: { id: 'wal_1' } }));
    const db = {
      workspaceMember: { count: vi.fn().mockResolvedValue(1), findFirst: vi.fn().mockResolvedValue({ workspace: { currency: 'NGN', region: 'ng' } }) },
      // create() opens a transaction so a first workspace and its welcome
      // credits land together or not at all.
      $transaction: vi.fn(async (fn: (t: unknown) => Promise<unknown>) => fn({ workspace: { create } })),
    };
    const service = new WorkspaceService(db as never, {} as never, { grant: vi.fn() } as never);
    await service.create('user', { name: 'Company', type: 'ORGANIZATION', billingCountry }, { get: () => undefined } as never);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ currency, profile: { billingCountry }, region: 'ng' }) }));
  });

  it('uses USD for a first workspace with unknown country', async () => {
    const create = vi.fn(async ({ data }) => ({ ...data, id: 'ws_1', wallet: { id: 'wal_1' } }));
    const db = {
      workspaceMember: { count: vi.fn().mockResolvedValue(0), findFirst: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (fn: (t: unknown) => Promise<unknown>) => fn({ workspace: { create } })),
    };
    await new WorkspaceService(db as never, {} as never, { grant: vi.fn() } as never).create('user', { name: 'Studio', type: 'BUSINESS' }, {
      get: () => undefined,
    } as never);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ currency: 'USD' }) }));
  });

  it.each([WorkspaceCreateDto, RegisterDto])('rejects invalid billing country on the API', async (dto) => {
    const errors = await validate(plainToInstance(dto, { billingCountry: 'ZZ' }));
    expect(errors.map((e) => e.property)).toContain('billingCountry');
  });
});
