import { describe, expect, it } from 'vitest';
import { parseCapabilityParams } from '@anystudio/shared';
import { toolFor } from './useGenerations';
import { TOOLS, coerceParams, restoreToolValues, toolById } from './tools';

describe('saved generation retry routing', () => {
  it('restores a Beautify result to Merchant shots without requiring a scene prompt', () => {
    // Regression: history used to label PRODUCT_SHOT as New scene. Retrying
    // sent this prompt-free input as IMAGE_EDIT and the API returned 400.
    const input = {
      sourceKey: 'workspace/photo.jpg',
      mode: 'beautify',
      aspect: '1:1',
      angleKeys: [],
      shadow: 'soft',
      shotSize: 'posting',
      sizes: ['feed_square', 'story'],
      subject: 'auto',
      textKind: 'artificial',
    };
    const restoredTool = toolById(toolFor('PRODUCT_SHOT'));
    expect(restoredTool.id).toBe('shots');
    const values = restoreToolValues(restoredTool, input);
    const capability = restoredTool.capabilityFor?.(values) ?? restoredTool.capability;
    expect(capability).toBe('PRODUCT_SHOT');
    const params = coerceParams(restoredTool, values);
    expect(params).toMatchObject({ sourceKey: input.sourceKey, mode: 'beautify' });
    expect(params).not.toHaveProperty('prompt');
    expect(parseCapabilityParams(capability, params).ok).toBe(true);
  });

  it('keeps every studio capability attached to a tool with the same capability', () => {
    for (const original of TOOLS) {
      const restored = toolById(toolFor(original.capability));
      expect(restored.capability, original.id).toBe(original.capability);
    }
  });

  it.each([
    ['COLLAGE', 'collage'],
    ['BATCH', 'batch'],
    ['UPSCALE', 'upscale'],
  ])('restores %s as %s', (capability, tool) => {
    expect(toolFor(capability)).toBe(tool);
  });
});
