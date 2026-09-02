/**
 * The auth shell: the proof column on the left, the form on the right — the
 * same composition as design/auth.html, so the prototype and the product do
 * not drift apart.
 */
import Link from 'next/link';
import styles from './auth.module.css';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={styles.shell}>
      <aside className={styles.aside}>
        <Link href="/" className={styles.brand} aria-label="AnyStudio home">
          <svg viewBox="0 0 24 24" aria-hidden="true" width="22" height="22">
            <rect x="1.5" y="1.5" width="21" height="21" rx="2" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <rect x="6" y="6" width="12" height="12" rx="1" fill="var(--accent)" />
          </svg>
          AnyStudio
        </Link>
        <div>
          <h2 className={styles.h2}>One photo in. Everything you post, out.</h2>
          <p className={styles.lede}>Branded images, a description, captions and a reel — from a single phone snapshot.</p>
        </div>
        <ul className={styles.trust}>
          <li>Three generations free — no card</li>
          <li>Works on WhatsApp and on the web</li>
          <li>Your images stay private by default</li>
        </ul>
      </aside>
      <main className={styles.main}>{children}</main>
    </div>
  );
}
