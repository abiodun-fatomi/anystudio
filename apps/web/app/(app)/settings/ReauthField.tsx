'use client';
/**
 * The proof-of-credential input every sensitive form carries. Which one is
 * asked for follows the account: a password if there is one, otherwise a
 * code if two-step is on, otherwise nothing (the server accepts the session).
 */
import { CodeInput, PasswordInput } from '@/components/ui';
import type { Profile } from '@/lib/api';

export type ReauthValue = { currentPassword?: string; code?: string };

export function reauthKind(p: Profile | null): 'password' | 'code' | 'none' {
  if (!p) return 'none';
  if (p.hasPassword) return 'password';
  if (p.mfa.enabled) return 'code';
  return 'none';
}

export function ReauthField({
  profile,
  value,
  onChange,
  errors,
  autoFocus,
}: {
  profile: Profile | null;
  value: ReauthValue;
  onChange: (v: ReauthValue) => void;
  errors?: Record<string, string>;
  autoFocus?: boolean;
}) {
  const kind = reauthKind(profile);
  if (kind === 'password') {
    return (
      <PasswordInput
        label="Your current password"
        autoComplete="current-password"
        value={value.currentPassword ?? ''}
        onChange={(e) => onChange({ ...value, currentPassword: e.target.value })}
        error={errors?.currentPassword}
        autoFocus={autoFocus}
      />
    );
  }
  if (kind === 'code') {
    return (
      <CodeInput
        label="Code from your authenticator app"
        accepts="either"
        placeholder="123456"
        value={value.code ?? ''}
        onValueChange={(v) => onChange({ ...value, code: v })}
        error={errors?.code}
        hint="A recovery code works too."
        autoFocus={autoFocus}
      />
    );
  }
  return null;
}
