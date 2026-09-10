'use client';
/**
 * The box people type an authentication code into.
 *
 * The rule it enforces — and why it differs per box — lives in
 * lib/auth-code.ts, next to its tests. This is only the input.
 */
import { forwardRef } from 'react';
import { cleanCode, type CodeAccepts } from '@/lib/auth-code';
import { Input } from './Field';

/** What the server will actually look at, per kind. */
const MODE = { totp: { max: 6, mode: 'numeric' as const }, either: { max: 8, mode: 'text' as const } };

type Props = Omit<React.ComponentProps<typeof Input>, 'onChange' | 'value' | 'inputMode' | 'type'> & {
  accepts: CodeAccepts;
  value: string;
  onValueChange: (v: string) => void;
};

export const CodeInput = forwardRef<HTMLInputElement, Props>(function CodeInput({ accepts, value, onValueChange, ...rest }, ref) {
  const m = MODE[accepts];
  return (
    <Input
      ref={ref}
      {...rest}
      type="text"
      inputMode={m.mode}
      autoComplete="one-time-code"
      // A paste of "063296 " or "AB-CD-1234" is someone doing the right
      // thing; clean it rather than making them retype it.
      maxLength={m.max}
      spellCheck={false}
      autoCapitalize={accepts === 'either' ? 'characters' : 'off'}
      value={value}
      onChange={(e) => onValueChange(cleanCode(e.target.value, accepts))}
    />
  );
});
