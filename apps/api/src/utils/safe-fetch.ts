/**
 * fetch() for URLs a customer gave us.
 *
 * A hostname check alone is not enough: DNS can point a public name at a
 * private address, a redirect can land anywhere, and "127.1" is a valid
 * spelling of localhost. So every hop is resolved first and refused when
 * any answer is loopback, link-local, private, multicast or otherwise not
 * a public unicast address; redirects are followed by hand, up to a few,
 * each re-checked; only https is allowed at every hop.
 */
import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';

const MAX_REDIRECTS = 4;

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeUrlError';
  }
}

function privateV4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number) as [number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function privateV6(ip: string): boolean {
  const v = ip.toLowerCase();
  if (v === '::' || v === '::1') return true;
  if (v.startsWith('::ffff:')) {
    const tail = v.slice(7);
    return isIP(tail) === 4 ? privateV4(tail) : true;
  }
  return (
    v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb') || v.startsWith('ff')
  );
}

export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return privateV4(ip);
  if (kind === 6) return privateV6(ip);
  return true;
}

/** Throws UnsafeUrlError unless every address the host resolves to is public. */
export async function assertPublicHost(u: URL): Promise<void> {
  if (u.protocol !== 'https:') throw new UnsafeUrlError('Only https addresses are fetched.');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.arpa'))
    throw new UnsafeUrlError('That address cannot be fetched.');
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new UnsafeUrlError('That address cannot be fetched.');
    return;
  }
  let answers: Array<{ address: string }>;
  try {
    answers = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new UnsafeUrlError('That address could not be resolved.');
  }
  if (answers.length === 0 || answers.some((a) => isPrivateAddress(a.address))) throw new UnsafeUrlError('That address cannot be fetched.');
}

/**
 * fetch with the checks above on the first request and on every redirect.
 * Same options as fetch, minus `redirect`, which is handled here.
 */
export async function safeFetch(input: string | URL, init: Omit<RequestInit, 'redirect'> = {}): Promise<Response> {
  let url = typeof input === 'string' ? new URL(input) : input;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicHost(url);
    const res = await fetch(url, { ...init, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return res;
      if (hop === MAX_REDIRECTS) throw new UnsafeUrlError('Too many redirects.');
      url = new URL(loc, url);
      // A redirect must not carry the caller's authorization to another host.
      if (init.headers && url.origin !== (typeof input === 'string' ? new URL(input) : input).origin) {
        const h = new Headers(init.headers);
        h.delete('authorization');
        h.delete('x-shopify-access-token');
        init = { ...init, headers: h };
      }
      continue;
    }
    return res;
  }
  throw new UnsafeUrlError('Too many redirects.');
}
