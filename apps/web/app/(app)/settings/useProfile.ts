'use client';
/** One read of /me/profile shared by the settings screens, with a way to re-read it after a change. */
import { useCallback, useEffect, useState } from 'react';
import { api, type Profile } from '@/lib/api';

export function useProfile() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      const p = await api.account.profile();
      // An older API (a deploy in flight) may answer without the newer
      // sections; the screens read them as empty rather than crashing.
      setProfile({
        ...p,
        hasPassword: p.hasPassword ?? true,
        mfa: p.mfa ?? { enabled: false, factors: [], recoveryCodesLeft: 0 },
        identities: p.identities ?? [],
        pendingEmail: p.pendingEmail ?? null,
        deletion: p.deletion ?? null,
      });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your profile.');
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { profile, error, reload };
}

/** Field errors from a 400 as `{ field: message }`, so a form can show them inline. */
export function fieldErrors(e: unknown): Record<string, string> {
  const fields = (e as { fields?: Array<{ path: string; message: string }> })?.fields ?? [];
  const out: Record<string, string> = {};
  for (const f of fields) out[f.path] = f.message;
  // Service-level ValidationError carries `details` on the envelope as fields too; fall back to the message.
  return out;
}
