'use client';
/**
 * The signed-in shell: sidebar, top bar, and the guided tour, which asks the
 * server what it owes and shows nothing on a repeat visit.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useMe } from '@/lib/useMe';
import { GuidedTour } from '@/components/GuidedTour';
import { siblingOrigin } from '@/lib/hosts';
import styles from './app.module.css';

const NAV = [
  ['/today', 'Today', 'today'], ['/create', 'Create', 'create'], ['/library', 'Library', 'library'],
  ['/products', 'Products', 'products'], ['/brand', 'Brand kit', 'brand-kit'],
  ['/publishing', 'Publishing', 'publishing'], ['/insights', 'Insights', 'insights'],
  ['/billing', 'Credits & billing', 'credits'],
] as const;

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { me, loading } = useMe();
  const path = usePathname();
  if (loading || !me) return <div className={styles.loading} aria-busy="true" />;
  const ws = me.workspaces[0];

  return (
    <div className={styles.frame}>
      <aside className={styles.side}>
        <div className={styles.brand}>
          <svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true">
            <rect x="1.5" y="1.5" width="21" height="21" rx="2" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <rect x="6" y="6" width="12" height="12" rx="1" fill="var(--accent)" />
          </svg>
          AnyStudio
        </div>
        <nav className={styles.nav}>
          {NAV.map(([href, label, tour]) => (
            <Link key={href} href={href} data-tour={tour} aria-current={path.startsWith(href) ? 'page' : undefined}>{label}</Link>
          ))}
        </nav>
        <div className={styles.foot}>
          <strong>{ws?.name ?? 'No workspace yet'}</strong>
          <span className="mono">{ws ? `${ws.type} · ${ws.currency}` : ''}</span>
          {me.canSwitchToStaff && (
            <a href={siblingOrigin(window.location.host, 'admin')} className={styles.staff}>Staff console →</a>
          )}
        </div>
      </aside>
      <main className={styles.main}>{children}</main>
      <GuidedTour />
    </div>
  );
}
