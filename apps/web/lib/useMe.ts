'use client';
/**
 * Who is signed in, for client components. One fetch, cached for the page
 * lifetime; a 401 sends the person to sign-in with a return path.
 */
import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { api, ApiError, type Me } from './api';

export function useMe(): { me: Me | null; loading: boolean } {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const path = usePathname();

  useEffect(() => {
    let live = true;
    api.auth.me()
      .then((m) => { if (live) setMe(m); })
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 401) router.replace(`/login?next=${encodeURIComponent(path)}`);
      })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [router, path]);

  return { me, loading };
}
