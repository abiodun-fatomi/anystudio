/**
 * Development-only routes. In production these do not exist: the layout
 * answers 404 before any child renders, so a gallery of every component
 * never ships to a customer's browser.
 */
import { notFound } from 'next/navigation';

export default function DevLayout({ children }: { children: React.ReactNode }) {
  if (process.env.NODE_ENV === 'production') notFound();
  return <>{children}</>;
}
