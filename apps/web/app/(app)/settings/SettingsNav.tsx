'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import styles from './settings.module.css';

const ITEMS = [
  { href: '/settings/profile', label: 'Profile' },
  { href: '/settings/security', label: 'Security' },
  { href: '/settings/workspace', label: 'Workspace' },
  { href: '/settings/notifications', label: 'Notifications' },
  { href: '/settings/data', label: 'Your data' },
];

export function SettingsNav() {
  const path = usePathname();
  return (
    <nav className={styles.nav} aria-label="Settings sections">
      {ITEMS.map((i) => (
        <Link key={i.href} href={i.href} className={styles.navItem} aria-current={path.startsWith(i.href) ? 'page' : undefined}>
          {i.label}
        </Link>
      ))}
    </nav>
  );
}
