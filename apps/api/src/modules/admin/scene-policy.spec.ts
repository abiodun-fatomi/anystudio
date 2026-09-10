import { describe, expect, it } from 'vitest';
import { validate } from 'class-validator';
import { SCENE_ACCEPTANCE_DEFAULT, sceneConfig } from '@anystudio/shared';
import { ProviderPatchDto } from './admin.dto';

describe('admin New Scene policy validation', () => {
  it('validates other use cases and disallows unsupported ones', async () => {
    expect(await validate(Object.assign(new ProviderPatchDto(), { preservationUseCase: 'expand', preservationAcceptance: 0.5 }))).toEqual([]);
    expect((await validate(Object.assign(new ProviderPatchDto(), { preservationUseCase: 'video', preservationAcceptance: 0.5 }))).length).toBeGreaterThan(0);
    expect((await validate(Object.assign(new ProviderPatchDto(), { preservationUseCase: 'expand', preservationAcceptance: null }))).length).toBeGreaterThan(0);
  });
  it('defaults to 0.50 and ignores corrupt stored values', () => {
    expect(SCENE_ACCEPTANCE_DEFAULT).toBe(0.5);
    expect(sceneConfig({ sceneAcceptance: NaN, scenePriority: -1 })).toEqual({});
    expect(sceneConfig({ sceneAcceptance: 0.5, scenePriority: 2 })).toEqual({ sceneAcceptance: 0.5, scenePriority: 2 });
  });
  it.each([0, 1.1, NaN, Infinity, '0.5', null])('rejects invalid acceptance %s', async (value) => {
    const dto = Object.assign(new ProviderPatchDto(), { sceneAcceptance: value });
    expect((await validate(dto)).length).toBeGreaterThan(0);
  });
  it.each([0, 1001, 1.5])('rejects invalid priority %s', async (scenePriority) => {
    expect((await validate(Object.assign(new ProviderPatchDto(), { scenePriority }))).length).toBeGreaterThan(0);
  });
  it('accepts valid policy edits', async () => {
    expect(await validate(Object.assign(new ProviderPatchDto(), { sceneAcceptance: 0.5, scenePriority: 10, reason: 'Quality review' }))).toEqual([]);
  });
});
