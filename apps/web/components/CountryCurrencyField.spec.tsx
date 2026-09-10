// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CountryCurrencyField } from './CountryCurrencyField';
vi.mock('@/components/ui/PhoneInput', () => ({
  countryOptions: () => [
    { value: 'NG', label: 'Nigeria' },
    { value: 'GB', label: 'United Kingdom' },
    { value: 'KE', label: 'Kenya' },
  ],
  detectCountry: () => null,
}));
let root: Root;
let container: HTMLDivElement;
function Form({ suggestion }: { suggestion?: string }) {
  const [value, setValue] = useState('');
  return <CountryCurrencyField value={value} onChange={setValue} suggestedCountry={suggestion} />;
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});
it('shows provisional USD when location is unknown', async () => {
  await act(async () => root.render(<Form />));
  expect(container.querySelector('select')?.value).toBe('');
  expect(container.textContent).toContain('USD until you select');
});
it('suggests phone country but preserves an independent manual choice', async () => {
  await act(async () => root.render(<Form suggestion="NG" />));
  expect(container.textContent).toContain('NGN (₦)');
  const select = container.querySelector('select')!;
  await act(async () => {
    select.value = 'GB';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(container.textContent).toContain('GBP (£)');
  await act(async () => root.render(<Form suggestion="KE" />));
  expect(select.value).toBe('GB');
});
