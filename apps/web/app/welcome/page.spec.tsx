// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import WelcomePage from './page';
const mocks = vi.hoisted(() => ({
  me: { user: { name: 'Ada' }, workspaces: [] as Array<{ id: string }> },
  create: vi.fn(),
  patch: vi.fn(),
  replace: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: mocks.replace }) }));
vi.mock('@/lib/useMe', () => ({ useMe: () => ({ me: mocks.me }) }));
vi.mock('@/lib/api', () => ({ api: { workspace: { create: mocks.create, patchProfile: mocks.patch } } }));
vi.mock('@/components/ui/PhoneInput', () => ({ countryOptions: () => [{ value: 'GB', label: 'United Kingdom' }], detectCountry: () => null }));
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  mocks.me.workspaces = [];
  container = document.createElement('div');
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});
it('requires country even when Google onboarding questions are skipped', async () => {
  mocks.create.mockImplementation(() => new Promise(() => {}));
  await act(async () => root.render(<WelcomePage />));
  const skip = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Skip for now')!;
  await act(async () => skip.click());
  expect(mocks.create).not.toHaveBeenCalled();
  expect(container.textContent).toContain('Confirm your country');
  const country = container.querySelector('select')!;
  await act(async () => {
    country.value = 'GB';
    country.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await act(async () => skip.click());
  expect(mocks.create).toHaveBeenCalledWith({ name: 'Ada studio', type: 'BUSINESS', billingCountry: 'GB' });
});
it('never recreates an existing workspace or changes its currency', async () => {
  mocks.me.workspaces = [{ id: 'existing' }];
  await act(async () => root.render(<WelcomePage />));
  expect(container.querySelector('select')).toBeNull();
  await act(async () => [...container.querySelectorAll('button')].find((b) => b.textContent === 'Skip for now')!.click());
  expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.patch).not.toHaveBeenCalled();
  expect(mocks.replace).toHaveBeenCalledWith('/today');
});
