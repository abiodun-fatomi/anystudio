import { api, type AdminTemplate } from '@/lib/api';

/**
 * Producing the pictures the picker is built on.
 *
 * A template's tile has to be the template's own output — the same prompt,
 * the same providers, the same fidelity loop — or it is a promise the studio
 * cannot keep. So this does not upload artwork from somewhere else: it makes
 * an ORDINARY GENERATION per template, in the operator's own workspace, and
 * then names it as that template's example. Same routing, same cost, same
 * audit trail as any seller's job. It is charged, visibly, which is the
 * honest way to run something that spends vendor money.
 *
 * It runs in the browser rather than as a worker job on purpose. This is a
 * handful-of-times operation, and a queue, a job type and a retry policy for
 * something an operator watches once is infrastructure nobody will remember
 * the shape of in six months. The cost of that choice is that the tab has to
 * stay open, which the page says.
 *
 * Two properties matter more than speed:
 *
 *   RESUMABLE. Templates that already have a render are skipped, so a closed
 *   tab, a failed provider or a change of mind costs only what it had not
 *   reached yet. Running it twice is free.
 *
 *   SLOW ON PURPOSE. A small concurrency, because forty simultaneous jobs
 *   from one workspace is exactly the shape the rate limiter exists to stop,
 *   and being throttled halfway is worse than taking a few more minutes.
 */

/** Renders in flight at once. Enough to be worth doing, small enough not to look like abuse. */
const LANES = 3;
/** A scene takes ~25s; this is the point at which something has clearly gone wrong. */
const TIMEOUT_MS = 4 * 60 * 1000;
const POLL_MS = 3000;

export interface RenderProgress {
  done: number;
  total: number;
  /** The template being worked on, for the line under the bar. */
  current: string | null;
  failures: Array<{ code: string; why: string }>;
}

export interface RenderOptions {
  workspaceId: string;
  /** The storage key of the stock product photo every example is built from. */
  sourceKey: string;
  templates: AdminTemplate[];
  reason: string;
  onProgress: (p: RenderProgress) => void;
  signal: AbortSignal;
}

/**
 * One example per template that has none.
 *
 * Returns when every lane is empty. Failures are collected rather than
 * thrown: one provider refusing one prompt must not abandon the other forty,
 * and the operator needs the list at the end to decide what to retry or
 * reword.
 */
export async function renderMissingExamples(opts: RenderOptions): Promise<RenderProgress> {
  const queue = opts.templates.filter((t) => !t.thumbnailKey && t.active);
  const progress: RenderProgress = { done: 0, total: queue.length, current: null, failures: [] };
  opts.onProgress({ ...progress });
  if (queue.length === 0) return progress;

  let next = 0;
  const lane = async () => {
    for (;;) {
      if (opts.signal.aborted) return;
      const template = queue[next++];
      if (!template) return;
      progress.current = template.name;
      opts.onProgress({ ...progress });
      try {
        await renderOne(template, opts);
      } catch (e) {
        progress.failures.push({ code: template.code, why: e instanceof Error ? e.message : 'unknown' });
      }
      progress.done += 1;
      opts.onProgress({ ...progress, failures: [...progress.failures] });
    }
  };

  await Promise.all(Array.from({ length: Math.min(LANES, queue.length) }, lane));
  progress.current = null;
  opts.onProgress({ ...progress, failures: [...progress.failures] });
  return progress;
}

async function renderOne(template: AdminTemplate, opts: RenderOptions): Promise<void> {
  const prompt = typeof template.params.prompt === 'string' ? template.params.prompt : '';
  const cut = template.kind === 'cut';
  if (!cut && !prompt.trim()) throw new Error('no prompt to render');

  const { generation: created } = await api.generations.create(opts.workspaceId, {
    capability: cut ? 'BACKGROUND_REMOVE' : 'IMAGE_EDIT',
    params: cut
      ? { sourceKey: opts.sourceKey, background: typeof template.params.background === 'string' ? template.params.background : '#FFFFFF' }
      : {
          sourceKey: opts.sourceKey,
          prompt,
          preserveProduct: true,
          aspect: '1:1',
          sizes: [],
        },
    // Keyed on the template, so a re-run of a job still in flight joins the
    // existing one instead of paying for a second.
    clientKey: `template-example:${template.code}`,
  });

  const finished = await settle(opts.workspaceId, created.id, opts.signal);
  // `failureKind` is the machine-readable reason the row carries; the prose
  // one is not on this view, and the kind is what an operator acts on anyway
  // (LOW_QUALITY means reword the prompt, PROVIDER_DOWN means try later).
  if (finished.status !== 'SUCCEEDED') throw new Error(finished.failureKind ?? `generation ${finished.status.toLowerCase()}`);
  await api.admin.renderTemplate(template.code, created.id, opts.reason);
}

async function settle(workspaceId: string, id: string, signal: AbortSignal) {
  const until = Date.now() + TIMEOUT_MS;
  for (;;) {
    if (signal.aborted) throw new Error('stopped');
    const { generation: row } = await api.generations.get(workspaceId, id);
    if (row.status !== 'QUEUED' && row.status !== 'RUNNING') return row;
    if (Date.now() > until) throw new Error('took too long; left running');
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}
