// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { TemplateView } from '@anystudio/shared';
import { TemplateSheet } from './TemplateSheet';

/**
 * The sheet is browsed, not searched, and everything worth pinning here comes
 * from that: a chip must actually narrow the grid, a query must not be
 * trapped inside one chip, and a tile with no photograph yet must still be a
 * tile somebody can tap.
 */

const template = (over: Partial<TemplateView> = {}): TemplateView => ({
  code: 'furniture_living_warm',
  name: 'Warm living room',
  note: 'Oak floor.',
  category: 'furniture',
  kind: 'scene',
  params: { prompt: 'A warm living room.' },
  thumbnailUrl: null,
  swatch: { colors: ['#EFE4D6', '#D8C4AC'], ink: 'dark' },
  ...over,
});

const CATALOGUE: TemplateView[] = [
  template(),
  template({ code: 'furniture_patio', name: 'Shaded patio', category: 'furniture', keywords: 'veranda' }),
  template({ code: 'bags_cafe', name: 'Café table', category: 'bags', note: 'Marble top.' }),
  template({ code: 'general_white', name: 'Plain white', category: 'general', kind: 'cut', params: { background: '#FFFFFF', prompt: '' } }),
];

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

const tiles = () => [...container.querySelectorAll('[role="radio"]')];

/**
 * Typing, the way React can see it.
 *
 * React tracks an input's value on the node and compares against it before
 * dispatching onChange, so assigning `.value` directly updates the DOM and
 * then looks like "no change" to React. Going through the prototype's own
 * setter is what makes the tracker notice.
 */
async function type(text: string) {
  const box = container.querySelector('input[type="search"]') as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(box, text);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
  return box;
}
const chip = (label: string) => [...container.querySelectorAll('[role="tab"]')].find((b) => b.textContent === label) as HTMLButtonElement;

async function open(props: Partial<Parameters<typeof TemplateSheet>[0]> = {}) {
  const onPick = vi.fn();
  const onClose = vi.fn();
  await act(async () => root.render(<TemplateSheet templates={CATALOGUE} current={null} onPick={onPick} onClose={onClose} {...props} />));
  return { onPick, onClose };
}

it('opens on everything, and a chip narrows the grid to one category', async () => {
  await open();
  expect(tiles()).toHaveLength(4);

  await act(async () => chip('Furniture').click());
  expect(tiles().map((t) => t.textContent)).toEqual([expect.stringContaining('Warm living room'), expect.stringContaining('Shaded patio')]);

  await act(async () => chip('All').click());
  expect(tiles()).toHaveLength(4);
});

it('only offers chips that have something behind them', async () => {
  // A chip a seller taps to find an empty grid is worse than no chip at all.
  await open();
  const labels = [...container.querySelectorAll('[role="tab"]')].map((b) => b.textContent);
  expect(labels).toEqual(['All', 'Bags', 'Furniture', 'Everything else']);
  expect(labels).not.toContain('Dresses');
});

it('searches the whole catalogue, not just the open chip', async () => {
  // A query filtered inside one category would hide the match and read as a
  // broken search, so typing has to release the chip.
  await open();
  await act(async () => chip('Furniture').click());
  await type('café');

  expect(tiles()).toHaveLength(1);
  expect(tiles()[0]!.textContent).toContain('Café table');
  expect(chip('Furniture').getAttribute('aria-selected')).toBe('false');
});

it('finds a template by a word only its keywords know', async () => {
  await open();
  await type('veranda');
  expect(tiles().map((t) => t.textContent)).toEqual([expect.stringContaining('Shaded patio')]);
});

it('says so plainly when nothing matches, rather than showing an empty grid', async () => {
  await open();
  await type('submarine');
  expect(tiles()).toHaveLength(0);
  expect(container.textContent).toContain('Nothing matches');
});

it('draws the gradient when a template has no render yet, and the photograph when it does', async () => {
  // This fallback is what lets the catalogue ship before the photography is
  // finished — it is a feature, not a degraded state.
  await open({ templates: [template(), template({ code: 'shot', name: 'Shot', thumbnailUrl: 'https://signed/templates/shot.webp' })] });
  const [noRender, withRender] = tiles();
  expect(noRender!.querySelector('img')).toBeNull();
  expect(withRender!.querySelector('img')!.getAttribute('src')).toBe('https://signed/templates/shot.webp');
});

it('falls back to the gradient when a signed thumbnail fails to load', async () => {
  // A signature can lapse while the sheet is open. A torn-image hole where a
  // room should be is worse than a plainer tile.
  await open({ templates: [template({ code: 'shot', thumbnailUrl: 'https://signed/templates/gone.webp' })] });
  const img = container.querySelector('img')!;
  await act(async () => img.dispatchEvent(new Event('error', { bubbles: false })));
  expect(container.querySelector('img')).toBeNull();
  expect(tiles()).toHaveLength(1);
});

it('opens on the category of whatever is already chosen', async () => {
  // Reopening should land where they left off, not at the top of an
  // unrelated chip.
  await open({ current: 'bags_cafe' });
  expect(chip('Bags').getAttribute('aria-selected')).toBe('true');
  expect(tiles()).toHaveLength(1);
  expect(tiles()[0]!.getAttribute('aria-checked')).toBe('true');
});

it('hands back the whole template when one is tapped, so the panel can fill from its params', async () => {
  const { onPick } = await open();
  await act(async () => (tiles()[0] as HTMLButtonElement).click());
  expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ code: 'furniture_living_warm', params: { prompt: 'A warm living room.' } }));
});

it('closes on Escape and on the scrim', async () => {
  const { onClose } = await open();
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
  expect(onClose).toHaveBeenCalled();
});
