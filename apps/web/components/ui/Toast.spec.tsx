// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ToastProvider, useToast } from './Toast';

/**
 * The one property jsdom can still hold: that the region asks for the top
 * layer.
 *
 * A toast fired while a modal dialog is open used to render UNDER it — the
 * dialog is promoted to the browser's top layer by `showModal()`, which no
 * z-index can reach. The fix is the `popover` attribute, and jsdom models
 * neither top layers nor paint order, so it cannot check the thing that
 * actually matters. What it CAN do is fail if someone removes the attribute,
 * which is the way the fix would realistically be lost.
 *
 * The behaviour itself was verified in Chromium: with a modal open, the pixel
 * at the toast's centre comes back undimmed and a click still reaches it.
 */

function Trigger({ label }: { label: string }) {
  const { toast } = useToast();
  return (
    <button type="button" onClick={() => toast({ title: label, body: 'why it happened', tone: 'danger' })}>
      fire
    </button>
  );
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const mount = async () =>
  act(async () =>
    root.render(
      <ToastProvider>
        <Trigger label="Refused" />
      </ToastProvider>,
    ),
  );

it('asks for the top layer, so a toast is never trapped under a modal dialog', async () => {
  await mount();
  const region = container.querySelector('[aria-live]')!;
  expect(region.getAttribute('popover')).toBe('manual');
});

it('keeps the live region in the tree even with nothing to say', async () => {
  // A live region added at the same moment as its first message is a live
  // region screen readers do not announce, which is why it is opened once and
  // never closed.
  await mount();
  expect(container.querySelector('[aria-live]')).not.toBeNull();
});

it('shows what it was told, and does not dismiss a refusal on its own', async () => {
  vi.useFakeTimers();
  try {
    await mount();
    await act(async () => container.querySelector('button')!.click());
    expect(container.textContent).toContain('Refused');
    expect(container.textContent).toContain('why it happened');
    // A message saying what went wrong must still be there when the person
    // looks up; only the friendly ones time out.
    await act(async () => void vi.advanceTimersByTime(60_000));
    expect(container.textContent).toContain('Refused');
  } finally {
    vi.useRealTimers();
  }
});
