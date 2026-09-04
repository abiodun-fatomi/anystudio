/**
 * Theme: three states. "system" stamps nothing and lets prefers-color-scheme
 * decide; "light" and "dark" stamp data-theme on <html>, which tokens.css
 * lets win in both directions. The choice is a per-browser convenience, so
 * it lives in localStorage, guarded — a private window or a blocked store
 * must not break the page.
 */

export type Theme = 'system' | 'light' | 'dark';
const KEY = 'anystudio:theme';

export function readTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
  try {
    if (theme === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  } catch {
    /* fine: the choice lasts the page */
  }
}

/** Inlined into <head> so the first paint is already the right theme. */
export const THEME_BOOT_SCRIPT = `(function(){try{var t=localStorage.getItem(${JSON.stringify(KEY)});if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t)}catch(e){}})();`;
