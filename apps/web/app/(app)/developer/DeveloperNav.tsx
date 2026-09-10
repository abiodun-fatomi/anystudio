'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import styles from './developer.module.css';

const ITEMS = [
  { href: '/developer', label: 'Overview', exact: true },
  { href: '/developer/keys', label: 'API keys' },
  { href: '/developer/webhooks', label: 'Webhooks' },
  { href: '/developer/projects', label: 'Projects' },
  { href: '/developer/docs', label: 'Quick start' },
];

export function DeveloperNav() {
  const path = usePathname();
  return (
    <nav className={styles.nav} aria-label="Developer sections">
      {ITEMS.map((i) => (
        <Link key={i.href} href={i.href} className={styles.navItem} aria-current={(i.exact ? path === i.href : path.startsWith(i.href)) ? 'page' : undefined}>
          {i.label}
        </Link>
      ))}
    </nav>
  );
}
