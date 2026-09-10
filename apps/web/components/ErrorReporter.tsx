'use client';
/**
 * Catches what the error boundaries cannot: errors thrown outside React's
 * render (event handlers, timers) and promise rejections nobody handled.
 * Mounted once in the root layout; renders nothing.
 */
import { useEffect } from 'react';
import { errorReportingOn, reportError } from '@/lib/report-error';

export function ErrorReporter() {
  useEffect(() => {
    if (!errorReportingOn) return;
    const onError = (e: ErrorEvent) => reportError(e.error ?? e.message, { where: 'window' });
    const onRejection = (e: PromiseRejectionEvent) => reportError(e.reason, { where: 'promise' });
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);
  return null;
}
