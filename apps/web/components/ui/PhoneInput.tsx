'use client';
/**
 * A phone number from anywhere: a country picker with its dialling code,
 * then the local number as the person is used to writing it. What leaves
 * the component is E.164 ("+2348012345678"), validated for that country,
 * so the API never has to guess where a number is from.
 *
 * The default country comes from the browser's locale, then its timezone
 * — a Lagos phone defaults to Nigeria, a Nairobi laptop to Kenya — and is
 * always changeable. The list is every country libphonenumber knows.
 */
import { useEffect, useMemo, useState } from 'react';
import { AsYouType, getCountries, getCountryCallingCode, isValidPhoneNumber, parsePhoneNumber, type CountryCode } from 'libphonenumber-js/min';
import styles from './PhoneInput.module.css';

const names = typeof Intl !== 'undefined' && 'DisplayNames' in Intl ? new Intl.DisplayNames(['en'], { type: 'region' }) : null;
const flag = (cc: string) => String.fromCodePoint(...[...cc.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
const COUNTRIES = getCountries().map((cc) => ({ cc, name: names?.of(cc) ?? cc, dial: getCountryCallingCode(cc) })).sort((a, b) => a.name.localeCompare(b.name));
/** The ones sellers here reach for first, pinned to the top. */
const PINNED: CountryCode[] = ['NG', 'GH', 'KE', 'ZA', 'US', 'GB'];

const TZ_TO_COUNTRY: Record<string, CountryCode> = { 'Africa/Lagos': 'NG', 'Africa/Accra': 'GH', 'Africa/Nairobi': 'KE', 'Africa/Johannesburg': 'ZA', 'Africa/Cairo': 'EG', 'Africa/Casablanca': 'MA', 'Africa/Dar_es_Salaam': 'TZ', 'Africa/Kampala': 'UG', 'Africa/Kigali': 'RW', 'Africa/Addis_Ababa': 'ET', 'Africa/Abidjan': 'CI', 'Africa/Dakar': 'SN', 'Africa/Douala': 'CM', 'Africa/Kinshasa': 'CD', 'Africa/Luanda': 'AO', 'Africa/Maputo': 'MZ', 'Africa/Harare': 'ZW', 'Africa/Lusaka': 'ZM', 'Europe/London': 'GB', 'America/New_York': 'US', 'America/Chicago': 'US', 'America/Los_Angeles': 'US', 'America/Toronto': 'CA', 'Asia/Dubai': 'AE', 'Asia/Kolkata': 'IN', 'Europe/Paris': 'FR', 'Europe/Berlin': 'DE' };

export function guessCountry(): CountryCode {
  try {
    const region = new Intl.Locale(navigator.language).region?.toUpperCase();
    if (region && (getCountries() as string[]).includes(region) && region !== 'US') return region as CountryCode;
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz && TZ_TO_COUNTRY[tz]) return TZ_TO_COUNTRY[tz]!;
    if (region && (getCountries() as string[]).includes(region)) return region as CountryCode;
  } catch { /* fall through */ }
  return 'NG';
}

export interface PhoneValue { country: CountryCode; national: string; e164: string | null; valid: boolean }

export function PhoneInput({ id, label = 'Phone number', value, onChange, required, hint, error, autoFocus }: {
  id?: string; label?: string; value: PhoneValue; onChange: (v: PhoneValue) => void; required?: boolean; hint?: string; error?: string | null; autoFocus?: boolean;
}) {
  const [touched, setTouched] = useState(false);
  // Country names come from Intl.DisplayNames, which differs between Node and the browser; the list is rendered after mount so the server and client agree.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); if (!value.country) onChange(compose(guessCountry(), '')); }, []);
  const dial = value.country ? getCountryCallingCode(value.country) : '';
  const options = useMemo(() => (mounted ? [...PINNED.map((cc) => COUNTRIES.find((c) => c.cc === cc)!).filter(Boolean), ...COUNTRIES.filter((c) => !PINNED.includes(c.cc))] : []), [mounted]);
  const showError = error ?? (touched && value.national && !value.valid ? `That does not look like a ${COUNTRIES.find((c) => c.cc === value.country)?.name ?? ''} number.` : null);
  const fieldId = id ?? 'phone';
  return (
    <div className="field">
      <label htmlFor={fieldId}>{label}</label>
      <div className={styles.row}>
        <div className={styles.country}>
          <span className={styles.flag} aria-hidden="true">{mounted && value.country ? flag(value.country) : '🌍'}</span>
          <span className={styles.dial}>{mounted ? `+${dial}` : '+'}</span>
          <select aria-label="Country" value={value.country} onChange={(e) => onChange(compose(e.target.value as CountryCode, value.national))} className={styles.select}>
            {options.map((c, i) => <option key={c.cc} value={c.cc}>{c.name} (+{c.dial}){i === PINNED.length - 1 ? ' ──' : ''}</option>)}
          </select>
        </div>
        <input id={fieldId} className={`inp ${styles.number}`} type="tel" inputMode="tel" autoComplete="tel-national" placeholder={placeholderFor(value.country)} value={value.national} required={required} autoFocus={autoFocus}
          aria-invalid={showError ? true : undefined} aria-describedby={showError ? `${fieldId}-err` : hint ? `${fieldId}-hint` : undefined}
          onChange={(e) => onChange(compose(value.country, e.target.value))} onBlur={() => setTouched(true)}
          onPaste={(e) => { const text = e.clipboardData.getData('text'); if (/^\+/.test(text.trim())) { e.preventDefault(); onChange(fromE164(text.trim(), value.country)); } }} />
      </div>
      {showError ? <p id={`${fieldId}-err`} className="err" role="alert" style={{ marginTop: 6 }}>{showError}</p> : hint ? <p id={`${fieldId}-hint`} style={{ marginTop: 6, fontSize: 13, color: 'var(--muted)' }}>{hint}</p> : null}
    </div>
  );
}

/** Build the value for a country and what was typed; formats as-you-type. */
export function compose(country: CountryCode, typed: string): PhoneValue {
  const formatter = new AsYouType(country);
  const national = formatter.input(typed.replace(/[^\d\s().-]/g, ''));
  let e164: string | null = null;
  try { e164 = typed.trim() ? parsePhoneNumber(typed, country).number : null; } catch { e164 = null; }
  const valid = Boolean(typed.trim()) && isValidPhoneNumber(typed, country);
  return { country, national, e164: valid ? e164 : null, valid };
}

/** A pasted +E.164 picks its own country. */
export function fromE164(text: string, fallback: CountryCode): PhoneValue {
  try {
    const p = parsePhoneNumber(text);
    if (p?.country) return compose(p.country, p.nationalNumber);
  } catch { /* not parseable */ }
  return compose(fallback, text);
}

export const emptyPhone = (): PhoneValue => ({ country: '' as CountryCode, national: '', e164: null, valid: false });

function placeholderFor(cc: CountryCode | ''): string {
  return ({ NG: '0801 234 5678', GH: '024 123 4567', KE: '0712 345678', ZA: '071 234 5678', US: '(201) 555-0123', GB: '07400 123456', IN: '081234 56789' } as Record<string, string>)[cc] ?? 'Local number';
}
