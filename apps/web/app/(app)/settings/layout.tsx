/**
 * Settings: one header, one row of sections, and each section its own
 * route so a link to "the security screen" is a link, not a tab index.
 */
import type { ReactNode } from 'react';
import { PageHeader } from '@/components/shell/Page';
import { SettingsNav } from './SettingsNav';
import styles from './settings.module.css';

export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="rise">
      <PageHeader title="Settings" lede="You, your sign-in, your workspace, and what we send you." />
      <SettingsNav />
      <div className={styles.body}>{children}</div>
    </div>
  );
}
