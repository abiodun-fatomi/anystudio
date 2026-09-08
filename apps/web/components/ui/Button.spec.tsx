// @vitest-environment jsdom
import { act, type AnchorHTMLAttributes } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Button } from './Button';
vi.mock('next/link', () => ({ default: (props: AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} /> }));
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});
it.each([{ disabled: true }, { loading: true }])('a blocked link-button cannot navigate: %j', async (props) => {
  const click = vi.fn();
  await act(async () =>
    root.render(
      <Button href="/billing" onClick={click} {...props}>
        Continue
      </Button>,
    ),
  );
  expect(container.querySelector('a')).toBeNull();
  const link = container.querySelector<HTMLElement>('[role="link"]')!;
  expect(link.getAttribute('aria-disabled')).toBe('true');
  await act(async () => link.click());
  expect(click).not.toHaveBeenCalled();
  if ('loading' in props) expect(link.getAttribute('aria-busy')).toBe('true');
});
it('an enabled link preserves accessible labels and click behavior', async () => {
  const click = vi.fn((e) => e.preventDefault());
  await act(async () =>
    root.render(
      <Button href="/billing" aria-label="Open billing" onClick={click}>
        Credits
      </Button>,
    ),
  );
  const link = container.querySelector('a')!;
  expect(link.getAttribute('href')).toBe('/billing');
  expect(link.getAttribute('aria-label')).toBe('Open billing');
  await act(async () => link.click());
  expect(click).toHaveBeenCalledTimes(1);
});
