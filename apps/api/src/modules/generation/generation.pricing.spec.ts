import { describe, expect, it } from 'vitest';
import { generationCostCode, generationQuantity, musicVoiceDowngradeCredits } from './generation.service';

describe('generation price selection', () => {
  it('keeps the existing Enhance price without discounting other image edits', () => {
    expect(generationCostCode('IMAGE_EDIT', { restyle: 'enhance' })).toBe('image.upscale');
    expect(generationCostCode('IMAGE_EDIT', { restyle: 'natural' })).toBe('image.storefront');
    expect(generationCostCode('BATCH', { of: 'IMAGE_EDIT', params: { restyle: 'enhance' } })).toBe('image.upscale');
  });
  it('never treats an arbitrary costCode-like param as the price', () => {
    expect(generationCostCode('TEXT_GENERATE', { task: 'product_copy', costCode: 'video.shot' })).toBe('text.description');
    expect(generationCostCode('IMAGE_EDIT', { costCode: 'video.shot' })).toBe('image.storefront');
  });

  it('derives the finite premium variants from capability params', () => {
    expect(generationCostCode('IMAGE_TO_VIDEO', { shots: 4, format: 'benefits' })).toBe('video.ad_30s');
    expect(generationCostCode('IMAGE_TO_VIDEO', { shots: 4, format: 'ugc' })).toBe('video.ad_30s');
    expect(generationCostCode('IMAGE_TO_VIDEO', { shots: 4, format: 'ugc', presenter: { kind: 'stock' } })).toBe('video.ad_30s_presenter');
    expect(generationCostCode('PRODUCT_SHOT', { mode: 'on_model', shotSize: 'printing' })).toBe('image.on_model.4k');
    expect(generationCostCode('MUSIC', { singer: 'me' })).toBe('audio.music.preview.my_voice');
    expect(generationCostCode('MUSIC', { singer: 'me', vocal: 'instrumental' })).toBe('audio.music.preview');
    expect(generationCostCode('DUB', { lipsync: true })).toBe('video.translate_lipsync');
    expect(generationCostCode('TEXT_GENERATE', { task: 'field' })).toBe('text.caption');
  });

  it('returns exactly the captured voice premium when the successful result kept the model singer', () => {
    const row = {
      capability: 'MUSIC',
      costCode: 'audio.music.preview.my_voice',
      credits: 80,
      input: { singer: 'me', _billing: { musicBaseCredits: 40 } },
    } as const;
    const downgraded = [{ key: 'result.json', role: 'text', mime: 'application/json', text: { myVoice: { applied: false } } }] as never;
    const applied = [{ key: 'result.json', role: 'text', mime: 'application/json', text: { myVoice: { applied: true } } }] as never;

    expect(musicVoiceDowngradeCredits(row as never, downgraded)).toBe(40);
    expect(musicVoiceDowngradeCredits(row as never, applied)).toBe(0);
    expect(musicVoiceDowngradeCredits({ ...row, input: { singer: 'me' } } as never, downgraded)).toBe(0);
  });

  it('charges once for every image the provider is asked to return', () => {
    expect(generationQuantity('IMAGE_GENERATE', { count: 4 })).toBe(4);
    expect(generationQuantity('IMAGE_GENERATE', { count: 999 })).toBe(4);
    expect(generationQuantity('IMAGE_GENERATE', {})).toBe(1);
  });

  it('charges music by each started 30-second block', () => {
    expect(generationQuantity('MUSIC', {})).toBe(4);
    expect(generationQuantity('MUSIC', { durationSec: 30 })).toBe(1);
    expect(generationQuantity('MUSIC', { durationSec: 31 })).toBe(2);
    expect(generationQuantity('MUSIC', { durationSec: 120 })).toBe(4);
    expect(generationQuantity('MUSIC', { durationSec: 240, singer: 'me' })).toBe(8);
  });

  it('charges voice-only dubbing by started minute and lip work by started half-minute', () => {
    expect(generationQuantity('DUB', { lipsync: false, quality: 'speed' }, 60_000)).toBe(1);
    expect(generationQuantity('DUB', { lipsync: false, quality: 'speed' }, 60_001)).toBe(2);
    expect(generationQuantity('DUB', { lipsync: true, quality: 'speed' }, 61_000)).toBe(3);
    expect(generationQuantity('LIPSYNC', { quality: 'speed' }, 180_000)).toBe(6);
  });

  it('only doubles duration units when precision changes the paid lip model', () => {
    expect(generationQuantity('DUB', { lipsync: false, quality: 'precision' }, 61_000)).toBe(2);
    expect(generationQuantity('DUB', { lipsync: true, quality: 'precision' }, 61_000)).toBe(6);
    expect(generationQuantity('LIPSYNC', { quality: 'precision' }, 31_000)).toBe(4);
  });
});
