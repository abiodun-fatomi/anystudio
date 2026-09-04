/** Page chrome every screen shares: a title, one line of purpose, actions on the right. */
import type { ReactNode } from 'react';
import { Breadcrumbs } from '@/components/ui';
import styles from './Page.module.css';

export function PageHeader({ title, lede, actions, crumbs }: { title: ReactNode; lede?: ReactNode; actions?: ReactNode; crumbs?: Array<{ label: ReactNode; href?: string }> }) {
  return (
    <div className={styles.head}>
      <div>
        {crumbs && <div style={{ marginBottom: 'var(--s-2)' }}><Breadcrumbs items={crumbs} /></div>}
        <h1>{title}</h1>
        {lede && <p>{lede}</p>}
      </div>
      {actions && <div className={styles.actions}>{actions}</div>}
    </div>
  );
}

export function Section({ title, aside, children }: { title: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return <section className={styles.section}><h2>{title}{aside}</h2>{children}</section>;
}
