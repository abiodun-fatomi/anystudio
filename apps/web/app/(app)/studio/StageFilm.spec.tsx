// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GENERATION_STAGES } from '@anystudio/shared';
import { StageFilm } from './StageFilm';

/**
 * The animation's only job is to be TRUE: it shows the stage the worker is in,
 * and it shows nothing at all when nothing is being done yet.
 *
 * So what is pinned here is the mapping, not the choreography. A stage added
 * to GENERATION_STAGES with no phase behind it would fall through to "make"
 * and quietly animate a machine that might be queued — which is exactly the
 * dishonesty this component was written to avoid.
 */

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

async function show(props: Partial<Parameters<typeof StageFilm>[0]> = {}) {
  await act(async () => root.render(<StageFilm stage="generating" label="Working" {...props} />));
  return container.querySelector('[role="img"]') as HTMLElement;
}

it('gives every stage the pipeline can report a phase of its own', async () => {
  const seen = new Map<string, string>();
  for (const stage of GENERATION_STAGES) {
    const el = await show({ stage });
    seen.set(stage, el.dataset.phase!);
  }
  expect([...seen.entries()]).toEqual([
    ['queued', 'wait'],
    ['preparing', 'read'],
    ['routing', 'read'],
    ['generating', 'make'],
    ['composing', 'make'],
    ['waiting', 'wait'],
    ['storing', 'settle'],
    ['done', 'settle'],
    ['failed', 'settle'],
  ]);
});

it('does not animate a machine that has not started', async () => {
  // queued and waiting both mean "no worker is on this yet". Drawing a scan
  // over the photo there would be a progress bar that fills on a timer,
  // wearing a different costume.
  for (const stage of ['queued', 'waiting']) {
    const el = await show({ stage });
    expect(el.dataset.phase).toBe('wait');
  }
});

it('names the stage for a screen reader rather than leaving a decorative box', async () => {
  const el = await show({ stage: 'composing', label: 'Adding your name and price' });
  expect(el.getAttribute('aria-label')).toBe('Adding your name and price');
});

it('shows the seller their own photo when there is one', async () => {
  await show({ src: 'https://media.example/signed/hat.jpg', alt: 'Your photo' });
  const img = container.querySelector('img') as HTMLImageElement;
  expect(img.getAttribute('src')).toBe('https://media.example/signed/hat.jpg');
  expect(img.getAttribute('alt')).toBe('Your photo');
});

it('falls back to its own surface when the source will not load', async () => {
  // An expired signed URL, or a video key handed to an <img>, which is what
  // DUB and LIPSYNC would pass. Neither is worth showing anyone a broken
  // image icon over.
  await show({ src: 'https://media.example/expired.jpg' });
  const img = container.querySelector('img') as HTMLImageElement;
  await act(async () => img.dispatchEvent(new Event('error')));
  expect(container.querySelector('img')).toBeNull();
  expect(container.querySelector('[role="img"]')).not.toBeNull();
});

it('has no photo to show at all for a song or a voiceover', async () => {
  await show({ src: undefined });
  expect(container.querySelector('img')).toBeNull();
});
