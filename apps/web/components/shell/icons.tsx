/** The icon set: inline SVG, currentColor, 1.75 stroke. A dozen glyphs, no icon font, no library. */
import type { SVGProps } from 'react';

const base = (p: SVGProps<SVGSVGElement>) => ({ width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.75, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true, ...p });

export const Icon = {
  studio: (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><rect x="3" y="3" width="18" height="18" rx="3" /><path d="m3 15 4.5-4.5a2 2 0 0 1 2.8 0L15 15M13 13l1.5-1.5a2 2 0 0 1 2.8 0L21 15" /><circle cx="15.5" cy="8.5" r="1.5" /></svg>,
  library: (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><path d="M4 5h5l2 2h9v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5Z" /></svg>,
  brand: (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><path d="M12 3 4 7v6c0 4.4 3.4 7.6 8 8 4.6-.4 8-3.6 8-8V7l-8-4Z" /><path d="m9 12 2 2 4-4" /></svg>,
  credits: (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><circle cx="12" cy="12" r="8.5" /><path d="M9.5 9.5c.5-1 1.5-1.5 2.5-1.5 1.7 0 2.5 1 2.5 2 0 2-5 1.5-5 4 0 1 .8 2 2.5 2 1 0 2-.5 2.5-1.5M12 6.5V8m0 8v1.5" /></svg>,
  insights: (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><path d="M4 19V5M4 19h16M8 15v-4m4 4V8m4 7v-2" /></svg>,
  settings: (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" /></svg>,
  publish: (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><path d="M4 12v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6M12 4v11m0-11-4 4m4-4 4 4" /></svg>,
  bell: (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15L6 16ZM10 20a2 2 0 0 0 4 0" /></svg>,
  chevron: (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><path d="m6 9 6 6 6-6" /></svg>,
  check: (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><path d="m5 12 5 5L20 7" /></svg>,
  sun: (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>,
  moon: (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" /></svg>,
  user: (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><circle cx="12" cy="8" r="4" /><path d="M4 20a8 8 0 0 1 16 0" /></svg>,
  logout: (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4M15 8l4 4-4 4M19 12H9" /></svg>,
  menu: (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><path d="M4 7h16M4 12h16M4 17h16" /></svg>,
  plus: (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><path d="M12 5v14M5 12h14" /></svg>,
  swap: (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><path d="M7 3v13m0 0-3-3m3 3 3-3M17 21V8m0 0 3 3m-3-3-3 3" /></svg>,
  music: (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><path d="M9 18V6l11-2v12" /><circle cx="6" cy="18" r="3" /><circle cx="17" cy="16" r="3" /></svg>,
  mic: (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3m-4 0h8" /></svg>,
  translate: (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3Z" /></svg>,
  lips: (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><path d="M3 12c2.5-3.5 5-5 7-5 .8 0 1.4.4 2 1 .6-.6 1.2-1 2-1 2 0 4.5 1.5 7 5-2.5 3.5-5.5 5.5-9 5.5S5.5 15.5 3 12Z" /><path d="M3 12h18" /></svg>,
  film: (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M7 5v14M17 5v14M3 9h4m10 0h4M3 15h4m10 0h4" /></svg>,
  code: (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><path d="m8 8-4 4 4 4m8-8 4 4-4 4M14 5l-4 14" /></svg>,
  key: (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><circle cx="8" cy="15" r="4" /><path d="m11 12 8-8m-3 3 2 2m-5 1 2 2" /></svg>,
  webhook: (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><circle cx="6" cy="17" r="3" /><circle cx="18" cy="17" r="3" /><circle cx="12" cy="6" r="3" /><path d="M9 17h6M13.5 8.5 16 14M10.5 8.5 8 14" /></svg>,
  copy: (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h9" /></svg>,
  lock: (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>,
  today: (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4m8-4v4" /></svg>,
};
export type IconName = keyof typeof Icon;
