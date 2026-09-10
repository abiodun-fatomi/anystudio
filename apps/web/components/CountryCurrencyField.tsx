'use client';
import { useEffect, useRef, useState } from 'react';
import { currencyForCountry, CURRENCY_WORDS } from '@anystudio/shared';
import { countryOptions, detectCountry } from '@/components/ui/PhoneInput';

/** A phone/location suggestion is editable and never overrides a manual choice. */
export function CountryCurrencyField({
  value,
  onChange,
  suggestedCountry,
  id = 'billing-country',
}: {
  value: string;
  onChange: (country: string) => void;
  suggestedCountry?: string;
  id?: string;
}) {
  const edited = useRef(false);
  const [options, setOptions] = useState<Array<{ value: string; label: string }>>([]);
  useEffect(() => {
    setOptions(countryOptions());
  }, []);
  useEffect(() => {
    if (!edited.current) {
      const suggestion = suggestedCountry || detectCountry();
      if (suggestion) onChange(suggestion);
    }
  }, [suggestedCountry, onChange]);
  const currency = currencyForCountry(value);
  return (
    <div className="field">
      <label htmlFor={id}>Country of residence / business location</label>
      <select
        id={id}
        className="inp"
        autoComplete="country"
        required
        value={value}
        aria-describedby={`${id}-hint`}
        onChange={(e) => {
          edited.current = true;
          onChange(e.target.value);
        }}
      >
        <option value="">Select your country</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <p id={`${id}-hint`} style={{ color: 'var(--muted)', fontSize: 13, marginTop: 6 }}>
        {value ? `Prices will be shown in ${currency} (${CURRENCY_WORDS[currency].symbol}).` : 'Prices are shown in USD until you select a country.'} This can
        differ from your phone number’s country. Confirm it before continuing.
      </p>
    </div>
  );
}
