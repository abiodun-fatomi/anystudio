import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { capabilityParams } from '@anystudio/shared';
import { hashApiKey, looksLikeApiKey, mintApiKey, mintWebhookSecret, signWebhook, verifyWebhook } from './developer.types';
import { describeSchema } from './public-api.service';

describe('API keys', () => {
  it('mints a recognisable key, stores only its hash, and never mints the same one twice', () => {
    const a = mintApiKey('live');
    const b = mintApiKey('test');
    expect(a.key).toMatch(/^as_live_[A-Za-z0-9]{32}$/);
    expect(b.key).toMatch(/^as_test_[A-Za-z0-9]{32}$/);
    expect(a.prefix).toBe(a.key.slice(0, 16));
    expect(a.hash).toBe(hashApiKey(a.key));
    expect(a.hash).not.toContain(a.key.slice(8));
    expect(a.key).not.toBe(mintApiKey('live').key);
    expect(looksLikeApiKey(a.key)).toBe(true);
    expect(looksLikeApiKey('as_live_short')).toBe(false);
    expect(looksLikeApiKey(`sk_live_${'x'.repeat(32)}`)).toBe(false);
  });
});

describe('webhook signatures', () => {
  it('signs over the timestamp and body, verifies within tolerance, and rejects tampering and replays', () => {
    const secret = mintWebhookSecret();
    expect(secret).toMatch(/^whsec_[0-9a-f]{64}$/);
    const body = JSON.stringify({ id: 'evt_1', type: 'ping' });
    const now = 1_800_000_000;
    const header = signWebhook(secret, body, now);
    expect(header).toMatch(/^t=1800000000,v1=[0-9a-f]{64}$/);
    expect(verifyWebhook(secret, body, header, 300, now + 10)).toBe(true);
    expect(verifyWebhook(secret, body.replace('ping', 'pong'), header, 300, now + 10)).toBe(false);
    expect(verifyWebhook(`${secret}x`, body, header, 300, now + 10)).toBe(false);
    expect(verifyWebhook(secret, body, header, 300, now + 400)).toBe(false);
    expect(verifyWebhook(secret, body, 'garbage', 300, now)).toBe(false);
  });
});

describe('schema description', () => {
  it('reads fields, requiredness, defaults and enum values off the capability schemas, through refinements', () => {
    const music = describeSchema(capabilityParams.MUSIC);
    const brief = music.find((f) => f.name === 'brief')!;
    expect(brief).toMatchObject({ type: 'string', required: true });
    expect(music.find((f) => f.name === 'vocal')).toMatchObject({
      type: 'enum',
      required: false,
      default: 'female',
      values: ['male', 'female', 'duet', 'choir', 'instrumental'],
    });
    expect(music.find((f) => f.name === 'durationSec')).toMatchObject({ type: 'number', default: 120 });
    // LIPSYNC is a refined object; the fields are still visible.
    const lip = describeSchema(capabilityParams.LIPSYNC);
    expect(lip.map((f) => f.name)).toContain('audioKey');
    expect(lip.find((f) => f.name === 'consent')).toMatchObject({ type: 'literal', required: true, values: ['true'] });
    expect(describeSchema(z.string())).toEqual([]);
  });
});
