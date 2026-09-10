import { describe, expect, it } from 'vitest';
import { VOICES } from './seed-audio';

const INVALID_GOOGLE_AFRICAN_ENGLISH = [
  'en-NG-Standard-A',
  'en-NG-Standard-B',
  'en-NG-Standard-C',
  'en-NG-Standard-D',
  'en-KE-Standard-A',
  'en-KE-Standard-B',
  'en-ZA-Standard-A',
] as const;

describe('seeded voice availability', () => {
  it('keeps unsupported Google African-English ids inactive', () => {
    for (const id of INVALID_GOOGLE_AFRICAN_ENGLISH) {
      expect(VOICES.find((voice) => voice.providerVoiceId === id)).toMatchObject({ active: false });
    }
  });

  it('does not advertise any unsupported regional id as an active Google voice', () => {
    expect(VOICES.filter((voice) => voice.providerKey === 'google:tts' && voice.active !== false).map((voice) => voice.providerVoiceId)).not.toEqual(
      expect.arrayContaining(INVALID_GOOGLE_AFRICAN_ENGLISH),
    );
  });
});
