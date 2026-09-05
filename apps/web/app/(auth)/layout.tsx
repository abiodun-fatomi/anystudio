/**
 * The auth shell: the proof column on the left, the form on the right — the
 * same composition as design/auth.html, so the prototype and the product do
 * not drift apart.
 */
import { BrandLink } from './BrandLink';
import { SheetShowcase } from '@/components/SheetShowcase';
import styles from './auth.module.css';

const TRUST = ['Three generations free — no card', 'Works on WhatsApp and on the web', 'Your images stay private by default'];

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={styles.shell}>
      <aside className={styles.aside}>
        <BrandLink className={styles.brand}>
          <svg viewBox="0 0 24 24" aria-hidden="true" width="22" height="22">
            <rect x="1.5" y="1.5" width="21" height="21" rx="2" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <rect x="6" y="6" width="12" height="12" rx="1" fill="var(--accent)" />
          </svg>
          AnyStudio
        </BrandLink>
        <div>
          <h2 className={styles.h2}>One photo in. Everything you post, out.</h2>
          <p className={styles.lede}>This is the sheet a seller got back from a single phone snapshot taken on a kitchen table.</p>
        </div>
        <SheetShowcase />
        <div className={styles.foot}>
          {TRUST.map((t) => (
            <span key={t} className={styles.row}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4 12l6 6L20 6" />
              </svg>
              {t}
            </span>
          ))}
        </div>
      </aside>
      <main className={styles.main}>{children}</main>
    </div>
  );
}
