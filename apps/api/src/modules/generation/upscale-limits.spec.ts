import { describe, expect, it, vi } from 'vitest';
import { CLARITY_MAX_OUTPUT_PIXELS, validateUpscaleSize } from './upscale-limits';
import { GenerationService } from './generation.service';

describe('Enhance output size limits', () => {
  it('rejects the reported 3000 × 4500 source at 2×', () => {
    expect(() => validateUpscaleSize(3000, 4500, 2)).toThrow(/32 MP limit/);
  });
  it('allows the boundary and rejects one pixel beyond it', () => {
    expect(() => validateUpscaleSize(4096, 2048, 2)).not.toThrow();
    expect(4096 * 2048 * 4).toBe(CLARITY_MAX_OUTPUT_PIXELS);
    expect(() => validateUpscaleSize(4097, 2048, 2)).toThrow();
    expect(() => validateUpscaleSize(2000, 3000, 2)).not.toThrow();
    expect(() => validateUpscaleSize(2000, 3000, 4)).toThrow();
  });
  it.each(['request', 'quote', 'batch'] as const)('rejects an oversized %s before touching money or creating work', async (method) => {
    const transaction = vi.fn();
    const debit = vi.fn();
    const media = { requireReady: vi.fn(async () => ({ key: 'ws/image.jpg', width: 3000, height: 4500 })) };
    const service = new GenerationService(
      { $transaction: transaction, creditCost: { findUnique: vi.fn(async () => ({ code: 'image.upscale', credits: 3 })) } } as never,
      { debit } as never,
      media as never,
      {} as never,
      {} as never,
    );
    const params = { sourceKey: 'ws/image.jpg', factor: 2 };
    const action =
      method === 'batch'
        ? service.request({
            workspaceId: 'ws',
            requestedById: 'user',
            capability: 'BATCH',
            params: { of: 'UPSCALE', sourceKeys: ['ws/image.jpg', 'ws/second.jpg'], params: { factor: 2 } },
          })
        : method === 'request'
          ? service.request({ workspaceId: 'ws', requestedById: 'user', capability: 'UPSCALE', params })
          : service.quote('ws', 'UPSCALE', params);
    await expect(action).rejects.toMatchObject({ details: { factor: expect.stringContaining('32 MP') } });
    expect(transaction).not.toHaveBeenCalled();
    expect(debit).not.toHaveBeenCalled();
  });
});
