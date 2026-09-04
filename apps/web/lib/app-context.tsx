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
 */
'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { api, ApiError, type Me } from './api';

export interface WorkspaceRef { id: string; type: string; name: string; currency: string; role: string }

interface AppState {
  me: Me;
  workspace: WorkspaceRef;
  workspaces: WorkspaceRef[];
  switchWorkspace: (id: string) => void;
  balance: number | null;
  /** Optimistic: the number moves now; the ledger corrects it shortly. */
  spend: (credits: number) => void;
  refund: (credits: number) => void;
  setBalance: (n: number) => void;
  refreshBalance: () => Promise<void>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AppState | null>(null);
const WS_KEY = 'anystudio:workspace';
export const SIGNOUT_CHANNEL = 'anystudio:auth';

export function AppProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const path = usePathname();
  const [me, setMe] = useState<Me | null>(null);
  const [failed, setFailed] = useState(false);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [balance, setBalanceState] = useState<number | null>(null);
  const balanceReq = useRef(0);

  useEffect(() => {
    let live = true;
    api.auth.me()
      .then((m) => {
        if (!live) return;
        setMe(m);
        let preferred: string | null = null;
        try { preferred = localStorage.getItem(WS_KEY); } catch { /* fine */ }
        const first = m.workspaces.find((w) => w.id === preferred) ?? m.workspaces[0];
        setWorkspaceId(first?.id ?? null);
      })
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 401) router.replace(`/login?next=${encodeURIComponent(path)}`);
        else if (live) setFailed(true);
      });
    return () => { live = false; };
  }, [router, path]);

  const refreshBalance = useCallback(async () => {
    if (!workspaceId) return;
    const seq = ++balanceReq.current;
    try {
      const w = await api.wallet.summary(workspaceId);
      if (seq === balanceReq.current) setBalanceState(w.balance);
    } catch {
      /* the last known figure stays; a refresh failing is not news */
    }
  }, [workspaceId]);

  useEffect(() => { void refreshBalance(); }, [refreshBalance]);

  // Another tab signed out: leave too, immediately, without asking the server.
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const ch = new BroadcastChannel(SIGNOUT_CHANNEL);
    ch.onmessage = (e) => { if (e.data === 'signed-out') window.location.replace('/login?signedout=1'); };
    return () => ch.close();
  }, []);

  const signOut = useCallback(async () => {
    try { await api.auth.logout(); } catch { /* the cookie may already be gone; leave anyway */ }
    try { new BroadcastChannel(SIGNOUT_CHANNEL).postMessage('signed-out'); } catch { /* no other tabs then */ }
    try { localStorage.removeItem(WS_KEY); } catch { /* fine */ }
    // replace, not push: the signed-in screen must not be one back-press away.
    window.location.replace('/login?signedout=1');
  }, []);

  const value = useMemo<AppState | null>(() => {
    if (!me) return null;
    const workspace = me.workspaces.find((w) => w.id === workspaceId) ?? me.workspaces[0];
    if (!workspace) return null;
    return {
      me,
      workspace,
      workspaces: me.workspaces,
      switchWorkspace: (id) => {
        setWorkspaceId(id);
        setBalanceState(null);
        try { localStorage.setItem(WS_KEY, id); } catch { /* fine */ }
      },
      balance,
      spend: (c) => setBalanceState((b) => (b === null ? b : b - c)),
      refund: (c) => setBalanceState((b) => (b === null ? b : b + c)),
      setBalance: setBalanceState,
      refreshBalance,
      signOut,
    };
  }, [me, workspaceId, balance, refreshBalance, signOut]);

  if (failed) {
    return (
      <div style={{ minHeight: '100dvh', display: 'grid', placeItems: 'center', padding: 24, textAlign: 'center' }}>
        <div>
          <p style={{ fontWeight: 700 }}>We could not reach AnyStudio just now.</p>
          <p style={{ color: 'var(--muted)', marginTop: 8 }}>Check your connection and try again.</p>
          <button type="button" onClick={() => window.location.reload()} style={{ marginTop: 16, padding: '12px 18px', borderRadius: 8, border: '1px solid var(--line)', background: 'var(--surface-2)' }}>Try again</button>
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
