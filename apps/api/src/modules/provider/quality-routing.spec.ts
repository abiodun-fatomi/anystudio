import { describe, expect, it } from 'vitest';
import { capabilityParams } from '@anystudio/shared';
import { imageQualityPreference } from './quality-routing';

describe('research-informed image routing', () => {
  it('distinguishes design from photographic generation', () => {
    expect(imageQualityPreference('IMAGE_GENERATE', { useCase: 'design' })).toEqual(['vertex:gemini-3-pro-image', 'fal:flux-2-pro']);
    expect(imageQualityPreference('IMAGE_GENERATE', { useCase: 'photography' })).toEqual(['fal:flux-2-pro', 'vertex:gemini-3-pro-image']);
  });
  it('distinguishes typography from reference-photo editing', () => {
    expect(imageQualityPreference('IMAGE_EDIT', { useCase: 'design' })?.[0]).toBe('vertex:gemini-3-pro-image');
    expect(imageQualityPreference('IMAGE_EDIT', { useCase: 'photography' })?.[0]).toBe('fal:seedream-4.5-edit');
  });
  it('preserves database priorities for untagged inputs and never guesses from prompts', () => {
    expect(imageQualityPreference('IMAGE_EDIT', { prompt: 'flyer photo' })).toBeUndefined();
    expect(imageQualityPreference('IMAGE_GENERATE', null)).toBeUndefined();
    expect(imageQualityPreference('VOICEOVER', { useCase: 'design' })).toBeUndefined();
  });
  it('validates and retains explicit API intent without breaking older clients', () => {
    const base = { prompt: 'A flyer' };
    expect(capabilityParams.IMAGE_GENERATE.parse({ ...base, useCase: 'photography' }).useCase).toBe('photography');
    expect(capabilityParams.IMAGE_GENERATE.parse(base).useCase).toBeUndefined();
    expect(capabilityParams.IMAGE_GENERATE.safeParse({ ...base, useCase: 'unknown' }).success).toBe(false);
  });
});
