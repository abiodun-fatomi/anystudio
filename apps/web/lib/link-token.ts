'use client';
/**
 * The token in a link from an email (?token=…), read exactly once.
 *
 * These pages scrub the token from the address bar as soon as they have it,
 * so it does not sit in history or get shared with a screenshot. Reading it
 * through useSearchParams and scrubbing with history.replaceState is a
 * trap: the router mirrors replaceState into useSearchParams, the effect
 * runs a second time with no token, and the page reports "expired" over a
 * request that has already succeeded. So the token comes straight from the
 * location, once per mount — a ref stops the development double-run of
 * effects from reading it twice as well.
 *
 * `undefined` until the first client render has looked; `null` when the
 * address carried no token.
 */
import { useEffect, useRef, useState } from 'react';

export function useLinkToken(scrubTo: string): string | null | undefined {
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const read = useRef(false);
  useEffect(() => {
    if (read.current) return;
    read.current = true;
    const t = new URLSearchParams(window.location.search).get('token');
    if (t) window.history.replaceState(null, '', scrubTo);
    setToken(t);
  }, [scrubTo]);
  return token;
}

/**
 * Run a one-shot request for a token exactly once per mount. The token is
 * single-use on the server, so a second call — which React's development
 * mode makes by re-running effects — would come back "invalid" and
 * overwrite the real answer.
 */
export function useRedeemOnce(token: string | null | undefined, redeem: (token: string) => void, onMissing: () => void) {
  const started = useRef(false);
  // The latest callbacks, read at the moment the token arrives — the effect
  // must not re-run because a page re-rendered with new closures.
  const handlers = useRef({ redeem, onMissing });
  handlers.current = { redeem, onMissing };
  useEffect(() => {
    if (token === undefined || started.current) return;
    started.current = true;
    if (!token) handlers.current.onMissing();
    else handlers.current.redeem(token);
  }, [token]);
}
