/**
 * What every signed-in screen needs: who is here, which workspace is
 * active, and how many credits it has — as ONE piece of state, so the
 * balance in the top bar and the balance on a screen can never disagree.
 *
 * THE BALANCE IS ALLOWED TO BE FAST BUT NEVER WRONG FOR LONG
 * ---------------------------------------------------------
 * `spend()` moves the number the instant a generation is requested and
 * `refund()` moves it back; both are followed by `refreshBalance()`, which
 * asks the ledger and overwrites whatever the optimistic arithmetic said.
 * The ledger is the truth; the UI is a very recent rumour.
 *
 * SIGN OUT IS A PROMISE, NOT A REDIRECT
 * -------------------------------------
 * The server session is revoked first. Then every open tab is told through
 * a BroadcastChannel, caches are dropped, and only then does the browser
 * move — so a back button cannot resurrect a screen of private data.
 *
 * TWO DOORS, ONE HOUSE
 * --------------------
 * Organizations live on org.<base>, everyone else on app.<base>; same pages,
 * separate sessions (a __Host- cookie cannot cross hostnames). So the active
 * workspace must belong on THIS host. Picking one that lives on the other
 * host, or arriving here with nothing that belongs, asks the API for a
 * one-time hand-off and the browser walks across with the session in hand.
 */
'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { surfaceForWorkspaceType } from '@anystudio/shared';
import { siblingOrigin, isLocalHost, portalOf } from '@/lib/hosts';
import { api, ApiError, type Me } from './api';

/** Does this workspace belong on the host the browser is on? Locally, everything does. */
function belongsHere(type: string): boolean {
  const host = window.location.host;
  return isLocalHost(host) || surfaceForWorkspaceType(type) === portalOf(host);
}

/** Walk across to the other portal host with this session, landing on the workspace. */
async function hopTo(workspaceId: string, next: string): Promise<void> {
  const { url } = await api.auth.hop(workspaceId, next);
  window.location.assign(url);
}

export interface WorkspaceRef {
  id: string;
  type: string;
  name: string;
  currency: string;
  role: string;
}

interface AppState {
  me: Me;
  workspace: WorkspaceRef;
  workspaces: WorkspaceRef[];
  /** `type` lets a just-created workspace be opened before /auth/me has been re-read. */
  switchWorkspace: (id: string, type?: string) => void;
  balance: number | null;
  /** Optimistic: the number moves now; the ledger corrects it shortly. */
  spend: (credits: number) => void;
  refund: (credits: number) => void;
  setBalance: (n: number) => void;
  refreshBalance: () => Promise<void>;
  /** Re-read /auth/me: after a rename, a profile edit, joining or leaving a workspace. */
  refreshMe: () => Promise<void>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AppState | null>(null);
const WS_KEY = 'anystudio:workspace';
export const SIGNOUT_CHANNEL = 'anystudio:auth';

export function AppProvider({ children }: { children: ReactNode }) {
  const path = usePathname();
  const [me, setMe] = useState<Me | null>(null);
  const [failed, setFailed] = useState(false);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [balance, setBalanceState] = useState<number | null>(null);
  const balanceReq = useRef(0);

  useEffect(() => {
    let live = true;
    api.auth
      .me()
      .then((m) => {
        if (!live) return;
        setMe(m);
        // A hand-off from the other host names the workspace it was for.
        const asked = new URLSearchParams(window.location.search).get('ws');
        let preferred: string | null = asked;
        if (!preferred) {
          try {
            preferred = localStorage.getItem(WS_KEY);
          } catch {
            /* fine */
          }
        }
        const here = m.workspaces.filter((w) => belongsHere(w.type));
        const first = here.find((w) => w.id === preferred) ?? here[0];
        if (first) {
          setWorkspaceId(first.id);
          if (asked) {
            try {
              localStorage.setItem(WS_KEY, first.id);
            } catch {
              /* fine */
            }
          }
          return;
        }
        // Nothing of theirs lives on this host. Everything they have is on
        // the other one: go there with the session rather than show a
        // portal with no workspace in it. (Nothing anywhere → /welcome.)
        const elsewhere = m.workspaces.find((w) => w.id === preferred) ?? m.workspaces[0];
        if (elsewhere) {
          hopTo(elsewhere.id, path).catch(() => setFailed(true));
          return;
        }
        setWorkspaceId(null);
      })
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 401) window.location.replace(signInUrl(path));
        else if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [path]);

  const refreshBalance = useCallback(async () => {
    if (!workspaceId) return;
    const seq = ++balanceReq.current;
    try {
      const w = await api.wallet.summary(workspaceId);
      if (seq === balanceReq.current) setBalanceState(typeof w?.balance === 'number' ? w.balance : null);
    } catch {
      /* the last known figure stays; a refresh failing is not news */
    }
  }, [workspaceId]);

  useEffect(() => {
    void refreshBalance();
  }, [refreshBalance]);

  // Another tab signed out: leave too, immediately, without asking the server.
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const ch = new BroadcastChannel(SIGNOUT_CHANNEL);
    ch.onmessage = (e) => {
      if (e.data === 'signed-out') window.location.replace(signedOutUrl());
    };
    return () => ch.close();
  }, []);

  const refreshMe = useCallback(async () => {
    try {
      setMe(await api.auth.me());
    } catch {
      /* the old picture stands until the next load */
    }
  }, []);

  const signOut = useCallback(async () => {
    try {
      await api.auth.logout();
    } catch {
      /* the cookie may already be gone; leave anyway */
    }
    try {
      new BroadcastChannel(SIGNOUT_CHANNEL).postMessage('signed-out');
    } catch {
      /* no other tabs then */
    }
    try {
      localStorage.removeItem(WS_KEY);
    } catch {
      /* fine */
    }
    // replace, not push: the signed-in screen must not be one back-press away.
    window.location.replace(signedOutUrl());
  }, []);

  const value = useMemo<AppState | null>(() => {
    if (!me) return null;
    const workspace = me.workspaces.find((w) => w.id === workspaceId) ?? me.workspaces[0];
    if (!workspace) return null;
    return {
      me,
      workspace,
      workspaces: me.workspaces,
      switchWorkspace: (id, type) => {
        const kind = type ?? me.workspaces.find((w) => w.id === id)?.type;
        if (kind && !belongsHere(kind)) {
          // It lives on the other host: carry the session across.
          hopTo(id, '/today').catch(() => undefined);
          return;
        }
        setWorkspaceId(id);
        setBalanceState(null);
        try {
          localStorage.setItem(WS_KEY, id);
        } catch {
          /* fine */
        }
      },
      balance,
      spend: (c) => setBalanceState((b) => (b === null ? b : b - c)),
      refund: (c) => setBalanceState((b) => (b === null ? b : b + c)),
      setBalance: setBalanceState,
      refreshBalance,
      refreshMe,
      signOut,
    };
  }, [me, workspaceId, balance, refreshBalance, refreshMe, signOut]);

  if (failed) {
    return (
      <div style={{ minHeight: '100dvh', display: 'grid', placeItems: 'center', padding: 24, textAlign: 'center' }}>
        <div>
          <p style={{ fontWeight: 700 }}>We could not reach AnyStudio just now.</p>
          <p style={{ color: 'var(--muted)', marginTop: 8 }}>Check your connection and try again.</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{ marginTop: 16, padding: '12px 18px', borderRadius: 8, border: '1px solid var(--line)', background: 'var(--surface-2)' }}
          >
            Try again
          </button>
        </div>
      </div>
    );
  }
  if (!value) return <div style={{ minHeight: '100dvh', background: 'var(--paper)' }} aria-busy="true" />;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useApp must be used inside AppProvider');
  return ctx;
}

/**
 * Signed out means the landing, on the marketing host: `app.` is for people
 * who are signed in. Locally there is no host split, so the login page is
 * the landing.
 */
export function signedOutUrl(): string {
  const host = window.location.host;
  return isLocalHost(host) ? '/login?signedout=1' : `${siblingOrigin(host, '')}/?signedout=1`;
}

/**
 * The sign-in page, which lives on the marketing host, carrying the path to
 * come back to (on this host — the hand-off brings it across).
 */
export function signInUrl(next: string): string {
  const host = window.location.host;
  const base = isLocalHost(host) || host.startsWith('admin.') ? '' : siblingOrigin(host, '');
  // The org host has its own session; the sign-in page needs to know to
  // hand the person back to THIS host, not app.
  const door = host.startsWith('org.') ? '&to=org' : '';
  return `${base}/login?next=${encodeURIComponent(next)}${door}`;
}
