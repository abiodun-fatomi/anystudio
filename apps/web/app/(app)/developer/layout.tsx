/**
 * Developer: the organization's side of the product. Projects group keys
 * and usage; a key calls the same pipelines the studio does; webhooks say
 * when work is done. Each section is its own route.
 */
import type { ReactNode } from 'react';
import { PageHeader } from '@/components/shell/Page';
import { DeveloperNav } from './DeveloperNav';
import styles from './developer.module.css';

export default function DeveloperLayout({ children }: { children: ReactNode }) {
  return (
    <div className="rise">
      <PageHeader title="Developer" lede="Everything the studio makes, from your own code. Keys, webhooks, usage and the docs." />
      <DeveloperNav />
      <div className={styles.body}>{children}</div>
    </div>
  );
}
