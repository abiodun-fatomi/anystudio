'use client';
/**
 * The logo on the auth screens goes to the landing page — on the marketing
 * host, where it lives. "/" on the app host is the signed-in home and would
 * bounce a signed-out visitor straight back here. Locally there is no host
 * split and "/" is the landing.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { isLocalHost, siblingOrigin } from '@/lib/hosts';

export function BrandLink({ className, children }: { className?: string; children: ReactNode }) {
  const [href, setHref] = useState('/');
  useEffect(() => {
    const host = window.location.host;
    if (!isLocalHost(host)) setHref(`${siblingOrigin(host, '')}/`);
  }, []);
  return (
    <a href={href} className={className} aria-label="AnyStudio home">
      {children}
    </a>
  );
}
