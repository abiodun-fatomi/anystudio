import type { Metadata, Viewport } from 'next';
import '../styles/globals.css';

export const metadata: Metadata = {
  title: { default: 'AnyStudio', template: '%s · AnyStudio' },
  description: 'One product photo in. Everything you post, out.',
  robots: { index: false, follow: false }, // the app is not a marketing surface
  // app/icon.svg and app/apple-icon.png are picked up by file convention and
  // linked automatically; this only names the app for "Add to Home Screen".
  applicationName: 'AnyStudio',
  appleWebApp: { title: 'AnyStudio' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#EFECF1' },
    { media: '(prefers-color-scheme: dark)', color: '#0F0C13' },
  ],
};

/** Root layout: fonts, tokens, nothing else. Shells live in route groups. */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400;12..96,600;12..96,800&family=Hanken+Grotesk:wght@400;500;600&family=JetBrains+Mono:wght@400;500;700&display=swap" />
      </head>
      <body>{children}</body>
    </html>
  );
}
