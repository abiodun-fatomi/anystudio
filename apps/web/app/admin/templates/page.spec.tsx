// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ToastProvider } from '@/components/ui';
import TemplatesPage from './page';

/**
 * That this page RENDERS AT ALL, which is the thing nothing else checks.
 *
 * It shipped crashing. Not on the data, not on a bad response — on
 * `useApp must be used inside AppProvider`, thrown the moment React called
 * the component. The staff console has its own shell and deliberately does
 * not use the customer app's provider; its header comment says so. I reached
 * for `useApp()` anyway to get a workspace id, and nothing caught it: a hook
 * that throws at runtime is invisible to `tsc`, the specs beside it test a
 * pure function, and the suite never mounted the page.
 *
 * So the first test below mounts it, and the second encodes the actual rule
 * by making `useApp` throw exactly as it does outside the provider. If anyone
 * reaches for it here again, this file goes red instead of production.
 */

const mocks = vi.hoisted(() => ({
  templates: vi.fn(),
  atLeast: vi.fn(() => true),
  workspaces: [{ id: 'ws-1', name: 'Staff studio', type: 'BUSINESS', currency: 'NGN', role: 'OWNER' }],
}));

vi.mock('../AdminShell', () => ({
  useAdmin: () => ({ me: { user: { name: 'Ada' }, workspaces: mocks.workspaces }, role: 'ADMIN', atLeast: mocks.atLeast }),
}));

/**
 * The customer app's provider is NOT in the tree here, and this mock says so
 * in the only way that matters: by throwing, the way the real hook does.
 */
vi.mock('@/lib/app-context', () => ({
  useApp: () => {
    throw new Error('useApp must be used inside AppProvider');
  },
  AppProvider: () => null,
}));

vi.mock('@/lib/api', () => ({
  api: { admin: { templates: mocks.templates } },
}));
vi.mock('@/lib/upload', () => ({ uploadFile: vi.fn() }));

const ROW = {
  code: 'furniture_living_warm',
  name: 'Warm living room',
  note: 'Oak floor.',
  category: 'furniture',
  kind: 'scene',
  params: { prompt: 'A warm living room.' },
  thumbnailKey: null,
  swatch: { colors: ['#EFE4D6'], ink: 'dark' },
  keywords: null,
  active: true,
  sort: 10,
  operatorEdited: false,
};

let root: Root;
let container: HTMLDivElement;

/**
 * jsdom ships `<dialog>` without `showModal`/`close`, and the Dialog component
 * calls them in an effect. Without this the modal tests fail on the
 * environment rather than on the page, which is exactly the kind of noise
 * that gets a real failure waved through later.
 */
function teachJsdomAboutDialogs() {
  const proto = window.HTMLDialogElement?.prototype as (HTMLDialogElement & { showModal?: () => void }) | undefined;
  if (!proto || typeof proto.showModal === 'function') return;
  proto.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true;
  };
  proto.close = function close(this: HTMLDialogElement) {
    this.open = false;
  };
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  teachJsdomAboutDialogs();
  mocks.atLeast.mockReturnValue(true);
  mocks.templates.mockResolvedValue([ROW]);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const mount = async () =>
  act(async () =>
    root.render(
      <ToastProvider>
        <TemplatesPage />
      </ToastProvider>,
    ),
  );

it('renders inside the staff console, which has no AppProvider', async () => {
  await mount();
  expect(container.textContent).toContain('Templates');
  expect(container.textContent).toContain('Warm living room');
});

it('never reaches for the customer app context', async () => {
  // The mock above throws exactly as the real hook does outside its provider,
  // so a `useApp()` anywhere in this page fails this test rather than the page.
  await mount();
  expect(container.querySelector('table')).not.toBeNull();
});

it('says how many live templates still have no example, because that is the whole point', async () => {
  await mount();
  expect(container.textContent).toMatch(/1 live template has no example render/);
});

it('offers the render run only when there is something to render', async () => {
  mocks.templates.mockResolvedValue([{ ...ROW, thumbnailKey: 'templates/x.webp' }]);
  await mount();
  expect(container.textContent).not.toMatch(/no example render/);
});

it('makes the operator name the workspace that pays, rather than picking one silently', async () => {
  // These are real credits from a real balance, and the console has no
  // "current workspace" to fall back on.
  await mount();
  const open = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Render them all'))!;
  await act(async () => open.click());
  expect(container.textContent).toContain('Charge these to');
  expect(container.textContent).toContain('Staff studio');
});

it('will not start a run without a reason for the audit log', async () => {
  await mount();
  await act(async () => [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Render them all'))!.click());
  const start = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Choose a product photo'))! as HTMLButtonElement;
  expect(start.disabled).toBe(true);
});

it('says so plainly when the staff account has nowhere to bill the renders', async () => {
  mocks.workspaces = [];
  await mount();
  await act(async () => [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Render them all'))!.click());
  expect(container.textContent).toContain('no workspace to bill these to');
  mocks.workspaces = [{ id: 'ws-1', name: 'Staff studio', type: 'BUSINESS', currency: 'NGN', role: 'OWNER' }];
});

it('tells a non-admin why the page is empty instead of showing them a broken table', async () => {
  mocks.atLeast.mockReturnValue(false);
  await mount();
  expect(container.textContent).toContain('needs an admin');
  expect(container.querySelector('table')).toBeNull();
});

it('renders an empty catalogue rather than crashing when the API is down', async () => {
  mocks.templates.mockRejectedValue(new Error('api is down'));
  await mount();
  expect(container.textContent).toContain('Templates');
});
