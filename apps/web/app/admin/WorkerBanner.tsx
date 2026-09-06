'use client';
/**
 * "Why is it still queued?" — answered before anyone asks. A generation
 * only leaves QUEUED when a worker claims it, so a console page that shows
 * queued rows says plainly when no worker has reported in.
 */
import { useEffect, useState } from 'react';
import { api, type WorkerStatus } from '@/lib/api';
import styles from './admin.module.css';

function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export function WorkerBanner() {
  const [w, setW] = useState<WorkerStatus | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    const load = () =>
      api.admin
        .worker()
        .then((r) => live && setW(r))
        .catch(() => live && setW(null));
    void load();
    const t = setInterval(load, 30_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);
  if (w === undefined || w?.alive) return null;
  return (
    <div className={styles.workerBanner} role="status">
      <b>{w ? `No worker has checked in since ${ago(w.seenAt)}.` : 'No worker has ever checked in.'}</b>
      <span>
        Queued generations stay queued until one runs. On Render that is the <code>anystudio-worker-*</code> service — check it is deployed and its logs say
        &ldquo;queue consumers started&rdquo;. Locally: <code>pnpm --filter @anystudio/api dev:worker</code>.
      </span>
    </div>
  );
}
