/**
 * The signed-in frame.
 *
 * A rail on the left (labels above 1200px, icons below it, gone on a
 * phone), a bar on top (workspace, credits, avatar), bottom tabs on a phone
 * — one markup, three widths. The credit balance in the bar is a link to
 * the ledger, because a number you cannot audit is a number you do not
 * trust, and it moves the moment a generation is requested.
 */
'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useApp } from '@/lib/app-context';
import { applyTheme, readTheme, type Theme } from '@/lib/theme';
import { siblingOrigin } from '@/lib/hosts';
import { cx } from '@/lib/cx';
import { Avatar, MenuHeading, MenuItem, MenuSeparator, Popover } from '@/components/ui';
import { GuidedTour } from '@/components/GuidedTour';
import { Icon, type IconName } from './icons';
import { Bell } from './Bell';
import styles from './AppShell.module.css';

/** The rail. `tour` keys are what the onboarding tour spotlights; keep them. */
const RAIL_MIN = 200; const RAIL_MAX = 380; const RAIL_DEFAULT = 232;

const NAV: Array<{ href: string; label: string; icon: IconName; tour: string; mobile?: boolean }> = [
  { href: '/today', label: 'Today', icon: 'today', tour: 'today', mobile: true },
  { href: '/studio', label: 'Studio', icon: 'studio', tour: 'create', mobile: true },
  { href: '/library', label: 'Library', icon: 'library', tour: 'library', mobile: true },
  { href: '/brand', label: 'Brand', icon: 'brand', tour: 'brand-kit' },
  { href: '/publishing', label: 'Publishing', icon: 'publish', tour: 'publishing' },
  { href: '/insights', label: 'Insights', icon: 'insights', tour: 'insights' },
  { href: '/developer', label: 'Developer', icon: 'code', tour: 'developer' },
  { href: '/billing', label: 'Credits', icon: 'credits', tour: 'credits', mobile: true },
  { href: '/settings', label: 'Settings', icon: 'settings', tour: 'settings', mobile: true },
];

const WS_TYPE: Record<string, string> = { PERSONAL: 'Personal', BUSINESS: 'Business', ORGANIZATION: 'Organization' };

export function AppShell({ children }: { children: ReactNode }) {
  const { me, workspace, workspaces, switchWorkspace, balance, signOut } = useApp();
  const path = usePathname();
  const [rail, setRail] = useState<'full' | 'icons'>('full');
  const [railWidth, setRailWidth] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [theme, setTheme] = useState<Theme>('system');
  useEffect(() => {
    setTheme(readTheme());
    try {
      const r = localStorage.getItem('anystudio:rail');
      if (r === 'icons' || r === 'full') setRail(r);
      const w = Number(localStorage.getItem('anystudio:rail-width'));
      if (w >= RAIL_MIN && w <= RAIL_MAX) setRailWidth(w);
    } catch { /* no storage, defaults */ }
  }, []);
  const toggleRail = () => setRail((r) => { const next = r === 'full' ? 'icons' : 'full'; try { localStorage.setItem('anystudio:rail', next); } catch { /* fine */ } return next; });
  const setWidth = (w: number | null) => { setRailWidth(w); try { if (w === null) localStorage.removeItem('anystudio:rail-width'); else localStorage.setItem('anystudio:rail-width', String(w)); } catch { /* fine */ } };
  const startDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX; const startW = railWidth ?? RAIL_DEFAULT;
    setDragging(true);
    const move = (ev: PointerEvent) => setRailWidth(Math.min(RAIL_MAX, Math.max(RAIL_MIN, startW + ev.clientX - startX)));
    const up = (ev: PointerEvent) => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); setDragging(false); setWidth(Math.min(RAIL_MAX, Math.max(RAIL_MIN, startW + ev.clientX - startX))); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  const nudge = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowLeft') setWidth(Math.max(RAIL_MIN, (railWidth ?? RAIL_DEFAULT) - 16));
    else if (e.key === 'ArrowRight') setWidth(Math.min(RAIL_MAX, (railWidth ?? RAIL_DEFAULT) + 16));
    else if (e.key === 'Home') setWidth(null);
  };
  const pickTheme = (t: Theme) => { setTheme(t); applyTheme(t); };
  const isActive = (href: string) => path === href || path.startsWith(`${href}/`);

  return (
    <div className={styles.frame} data-rail={rail} data-dragging={dragging || undefined} style={railWidth ? ({ '--rail-w': `${railWidth}px` } as React.CSSProperties) : undefined}>
      <a href="#main" className={styles.skip}>Skip to content</a>

      <aside className={styles.rail} aria-label="Primary">
        <Link href="/today" className={styles.brand}>
          <span className={styles.mark} aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="2" fill="var(--accent)" /></svg>
          </span>
          <span className={styles.brandName}>AnyStudio</span>
        </Link>
        <nav className={styles.nav}>
          {NAV.filter((n) => n.href !== '/developer' || workspace.type === 'ORGANIZATION').map((n) => (
            <Link key={n.href} href={n.href} className={styles.item} data-tour={n.tour} aria-current={isActive(n.href) ? 'page' : undefined} title={n.label}>
              {Icon[n.icon]({})}
              <span className={styles.label}>{n.label}</span>
            </Link>
          ))}
        </nav>
        <div className={styles.railFoot}>
          {me.canSwitchToStaff && <a href={siblingOrigin(window.location.host, 'admin')} className={styles.staffLink} style={{ fontFamily: 'var(--f-mono)' }}>Staff console →</a>}
          <button type="button" className={cx(styles.item)} onClick={toggleRail} aria-label={rail === 'full' ? 'Collapse the sidebar' : 'Expand the sidebar'} aria-expanded={rail === 'full'} title={rail === 'full' ? 'Collapse' : 'Expand'}>
            {rail === 'full' ? <Icon.collapse /> : <Icon.expand />}
            <span className={styles.label}>Collapse</span>
          </button>
        </div>
        <div className={styles.handle} role="separator" aria-orientation="vertical" aria-label="Resize the sidebar (drag, or arrow keys; Home resets)" aria-valuenow={railWidth ?? RAIL_DEFAULT} aria-valuemin={RAIL_MIN} aria-valuemax={RAIL_MAX} tabIndex={0}
          data-dragging={dragging || undefined} onPointerDown={startDrag} onDoubleClick={() => setWidth(null)} onKeyDown={nudge} />
      </aside>

      <div className={styles.body}>
        <header className={styles.bar}>
          <WorkspaceSwitcher current={workspace} all={workspaces} onPick={switchWorkspace} />
          <div className={styles.spacer} />
          <CreditPill balance={balance} />
          <Bell />
          <Popover align="end" menu trigger={
            <button type="button" className={styles.avatarBtn} aria-label="Account menu"><Avatar name={me.user.name ?? me.user.email ?? 'You'} /></button>
          }>
            {(close) => (
              <>
                <div className={styles.menuUser}><span className={styles.menuName}>{me.user.name ?? 'Your account'}</span><span className={styles.menuEmail}>{me.user.email ?? me.user.phone}</span></div>
                <MenuSeparator />
                <MenuItem href="/settings/profile" onSelect={close} leading={<Icon.user />}>Profile</MenuItem>
                <MenuItem href="/settings" onSelect={close} leading={<Icon.settings />}>Settings</MenuItem>
                <MenuSeparator />
                <div className={styles.themeRow} role="group" aria-label="Theme">
                  <span style={{ fontSize: 'var(--t-2)' }}>Theme</span>
                  <div className={styles.themeSeg} role="radiogroup" aria-label="Theme">
                    <button type="button" role="radio" aria-checked={theme === 'light'} aria-label="Light" onClick={() => pickTheme('light')}><Icon.sun width={16} height={16} /></button>
                    <button type="button" role="radio" aria-checked={theme === 'system'} aria-label="System" onClick={() => pickTheme('system')}>Auto</button>
                    <button type="button" role="radio" aria-checked={theme === 'dark'} aria-label="Dark" onClick={() => pickTheme('dark')}><Icon.moon width={16} height={16} /></button>
                  </div>
                </div>
                <MenuSeparator />
                <MenuItem onSelect={() => void signOut()} leading={<Icon.logout />}>Sign out</MenuItem>
              </>
            )}
          </Popover>
        </header>
        <main id="main" className={styles.main} tabIndex={-1}>{children}</main>
      </div>

      <nav className={styles.tabs} aria-label="Primary">
        {NAV.filter((n) => n.mobile).map((n) => (
          <Link key={n.href} href={n.href} className={styles.tab} aria-current={isActive(n.href) ? 'page' : undefined}>
            {Icon[n.icon]({ width: 22, height: 22 })}<span>{n.label}</span>
          </Link>
        ))}
      </nav>
      <GuidedTour />
    </div>
  );
}

function WorkspaceSwitcher({ current, all, onPick }: { current: { id: string; name: string; type: string }; all: Array<{ id: string; name: string; type: string }>; onPick: (id: string) => void }) {
  const trigger = (
    <button type="button" className={styles.wsBtn} data-tour="workspace">
      <Avatar name={current.name} size="sm" square />
      <span className={styles.wsText}><span className={styles.wsName}>{current.name}</span><span className={styles.wsType}>{WS_TYPE[current.type] ?? current.type}</span></span>
      <Icon.chevron width={16} height={16} />
    </button>
  );
  if (all.length <= 1) return trigger;
  return (
    <Popover menu trigger={trigger}>
      {(close) => (
        <>
          <MenuHeading>Workspaces</MenuHeading>
          {all.map((w) => (
            <MenuItem key={w.id} onSelect={() => { onPick(w.id); close(); }} leading={w.id === current.id ? <Icon.check width={16} height={16} /> : <span style={{ width: 16 }} />}>
              <span style={{ display: 'grid' }}><span>{w.name}</span><span className={styles.wsType}>{WS_TYPE[w.type] ?? w.type}</span></span>
            </MenuItem>
          ))}
        </>
      )}
    </Popover>
  );
}

/** The balance, tweened between values so a spend reads as a spend. */
function CreditPill({ balance }: { balance: number | null }) {
  const [shown, setShown] = useState<number | null>(balance);
  const [moving, setMoving] = useState(false);
  const prev = useRef<number | null>(balance);
  useEffect(() => {
    if (balance === null || prev.current === null || prev.current === balance || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      prev.current = balance; setShown(balance); return;
    }
    const from = prev.current; const to = balance; const start = performance.now(); const dur = 500;
    setMoving(true);
    let raf = 0;
    const tick = (t: number) => {
      const k = Math.min(1, (t - start) / dur); const e = 1 - Math.pow(1 - k, 3);
      setShown(Math.round(from + (to - from) * e));
      if (k < 1) raf = requestAnimationFrame(tick); else { setMoving(false); prev.current = to; }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [balance]);
  const low = shown !== null && shown > 0 && shown < 20;
  return (
    <Link href="/billing" className={styles.credits} data-tour="credits" data-low={low || undefined} data-empty={shown === 0 || undefined} data-moving={moving || undefined} aria-label={shown === null ? 'Credits' : `${shown} credits`}>
      <Icon.credits width={16} height={16} />
      <span className={styles.num}>{shown === null ? '—' : shown.toLocaleString()}</span>
      <span className={styles.creditsWord}>credits</span>
    </Link>
  );
}
