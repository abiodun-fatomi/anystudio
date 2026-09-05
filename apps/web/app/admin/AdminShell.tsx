'use client';
/**
 * The staff console's frame. Its own provider: the console is not a
 * workspace app, so it does not use the customer AppProvider. It reads
 * /auth/me on the ADMIN surface — which only exists past a second factor —
 * and refuses anyone without a staff grant, in words.
 */
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError, type Me } from '@/lib/api';
import { Avatar, Button, EmptyState, Skeleton, ToastProvider } from '@/components/ui';
import { Icon, type IconName } from '@/components/shell/icons';
import { siblingOrigin } from '@/lib/hosts';
import styles from './admin.module.css';

type StaffRole = 'SUPPORT' | 'OPERATOR' | 'ADMIN' | 'SUPERADMIN';
const RANK: Record<StaffRole, number> = { SUPPORT: 1, OPERATOR: 2, ADMIN: 3, SUPERADMIN: 4 };
interface AdminState { me: Me; role: StaffRole; atLeast: (r: StaffRole) => boolean }
const Ctx = createContext<AdminState | null>(null);
export const useAdmin = (): AdminState => { const v = useContext(Ctx); if (!v) throw new Error('useAdmin outside AdminShell'); return v; };

const NAV: Array<{ href: string; label: string; icon: IconName; min?: StaffRole }> = [
  { href: '/admin', label: 'Overview', icon: 'today' },
  { href: '/admin/customers', label: 'Customers', icon: 'user' },
  { href: '/admin/generations', label: 'Generations', icon: 'studio' },
  { href: '/admin/payments', label: 'Payments', icon: 'credits' },
  { href: '/admin/providers', label: 'Providers & prices', icon: 'settings', min: 'OPERATOR' },
  { href: '/admin/messages', label: 'Messages', icon: 'bell', min: 'ADMIN' },
  { href: '/admin/staff', label: 'Staff', icon: 'lock', min: 'ADMIN' },
  { href: '/admin/audit', label: 'Audit log', icon: 'library' },
];

export function AdminShell({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [denied, setDenied] = useState<string | null>(null);
  const router = useRouter();
  const path = usePathname();

  useEffect(() => {
    api.auth.me().then((m) => {
      if (m.surface !== 'ADMIN') { router.replace('/login?next=/admin'); return; }
      if (!m.staffRole) { setDenied('This account has no staff access. Ask an admin to grant it, then sign in again with your second factor.'); setMe(null); return; }
      setMe(m);
    }).catch((e) => {
      if (e instanceof ApiError && e.status === 401) router.replace(`/login?next=${encodeURIComponent(path)}`);
      else setDenied('Could not reach the API.');
    });
  }, [router, path]);

  if (me === undefined && !denied) return <div className={styles.frame}><div className={styles.main}><Skeleton height={240} /></div></div>;
  if (!me) return <div className={styles.frame}><div className={styles.main}><EmptyState icon={<Icon.lock />} title="Staff console" body={denied} actions={<Button href="/login?next=/admin">Sign in again</Button>} /></div></div>;
  const role = me.staffRole as StaffRole;
  const atLeast = (r: StaffRole) => RANK[role] >= RANK[r];
  const signOut = async () => { try { await api.auth.logout(); } catch { /* fine */ } window.location.replace('/login?next=/admin'); };

  return (
    <Ctx.Provider value={{ me, role, atLeast }}>
      <ToastProvider>
        <div className={styles.frame}>
          <aside className={styles.rail} aria-label="Console">
            <div className={styles.brand}><span className={styles.mark} aria-hidden="true">A</span><span>Staff console</span><span className={styles.env}>{typeof window !== 'undefined' ? window.location.host.replace(/^admin\./, '') : ''}</span></div>
            <nav className={styles.nav}>
              {NAV.filter((n) => !n.min || atLeast(n.min)).map((n) => (
                <Link key={n.href} href={n.href} className={styles.item} aria-current={(n.href === '/admin' ? path === '/admin' : path.startsWith(n.href)) ? 'page' : undefined}>{Icon[n.icon]({ width: 18, height: 18 })}<span>{n.label}</span></Link>
              ))}
            </nav>
            <div className={styles.foot}>
              <div className={styles.who}><Avatar name={me.user.name ?? me.user.email ?? 'Staff'} /><span><strong>{me.user.name ?? me.user.email}</strong><span className={styles.role}>{role}</span></span></div>
              <a href={siblingOrigin(window.location.host, 'app')} className={styles.small}>Customer app →</a>
              <button type="button" className={styles.small} onClick={() => void signOut()}>Sign out</button>
            </div>
          </aside>
          <main className={styles.main} id="main">{children}</main>
        </div>
      </ToastProvider>
    </Ctx.Provider>
  );
}
