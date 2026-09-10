import { afterEach, expect, it, vi } from 'vitest';
import { WhatsappClient } from './whatsapp.client';

afterEach(() => vi.unstubAllEnvs());

it('gives local messages distinct durable IDs across client restarts and buffer resets', async () => {
  vi.stubEnv('WHATSAPP_PHONE_NUMBER_ID', '');
  vi.stubEnv('WHATSAPP_ACCESS_TOKEN', '');
  const first = new WhatsappClient();
  const message = { kind: 'text' as const, text: 'fixture' };
  const a = await first.send('234000000000', message);
  first.sent.length = 0;
  const b = await first.send('234000000000', message);
  const c = await new WhatsappClient().send('234000000000', message);
  expect(new Set([a.messageId, b.messageId, c.messageId]).size).toBe(3);
  expect([a, b, c].every((result) => result.ok && /^local-[0-9a-f-]{36}$/.test(result.messageId!))).toBe(true);
});
