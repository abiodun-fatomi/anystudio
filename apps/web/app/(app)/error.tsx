'use client';
/**
 * The last line before "Application error": a page inside the shell threw
 * while rendering. The rail and top bar stay; the page says what happened
 * in words and offers to try again, and the reference is what support asks
 * for. Most causes are a stale API answering a newer app — a deploy in
 * flight — and a retry a minute later is the fix.
 */
import { useEffect } from 'react';
import { Button, EmptyState } from '@/components/ui';
import { Icon } from '@/components/shell/icons';

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error('page crashed', error);
  }, [error]);
  return (
    <EmptyState
      icon={<Icon.studio />}
      title="This page hit a snag"
      body={`Something on this page did not load the way it should. It is usually brief — try again, and if it keeps happening tell us in the help chat${error.digest ? ` (ref ${error.digest})` : ''}.`}
      actions={
        <>
          <Button onClick={reset}>Try again</Button>
          <Button variant="ghost" href="/today">
            Back to Today
          </Button>
        </>
      }
    />
  );
}
