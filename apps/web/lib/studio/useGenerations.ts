/**
 * The studio's generation client: create → watch → render.
 *
 * Each card is a generation the person asked for this session. Its state
 * comes from three places, in order of authority: the row (fetched at the
 * start and at the end), the SSE stream while it runs, and the optimistic
 * "queued" the card starts in before the API has even answered. The stream
 * is a convenience; if it drops, the API's own fallback polls the row and
 * the card still reaches the truth.
 *
 * Credits: `spend()` moves the bar's number as the button is pressed;
 * the API's answer carries the real balance and overwrites it; a refund
 * arrives through the `done` event and a ledger refresh.
 */
'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { GenerationEvent, GenerationStage } from '@anystudio/shared';
import { api, ApiError, type GenerationOutputRow, type GenerationRow } from '@/lib/api';
import { useApp } from '@/lib/app-context';

export interface GenerationCard {
  /** Client id, stable from the first optimistic render; the server id arrives a beat later. */
  clientKey: string;
  id: string | null;
  toolId: string;
  capability: string;
  credits: number;
  status: 'requesting' | 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
  stage: GenerationStage;
  progress: number;
  detail?: string;
  outputs: GenerationOutputRow[];
  /** Signed URLs by key, fetched as outputs land. */
  urls: Record<string, string>;
  message?: string;
  params: Record<string, unknown>;
  sourceKey?: string;
  createdAt: number;
}

const MAX_CARDS = 30;

export function useGenerations() {
  const { workspace, spend, setBalance, refreshBalance } = useApp();
  const [cards, setCards] = useState<GenerationCard[]>([]);
  const streams = useRef(new Map<string, EventSource>());

  const patch = useCallback((clientKey: string, fn: (c: GenerationCard) => GenerationCard) => {
    setCards((cs) => cs.map((c) => (c.clientKey === clientKey ? fn(c) : c)));
  }, []);

  /** Resolve keys to URLs; failures leave the key without a URL, and the card shows a retry. */
  const resolveUrls = useCallback(
    async (clientKey: string, keys: string[]) => {
      if (keys.length === 0) return;
      try {
        const { urls } = await api.media.urls(workspace.id, keys);
        patch(clientKey, (c) => ({ ...c, urls: { ...c.urls, ...urls } }));
      } catch {
        /* the card offers a refresh */
      }
    },
    [workspace.id, patch],
  );

  /** Bring a card to the row's truth — used at the end, and whenever the stream is doubtful. */
  const sync = useCallback(
    async (clientKey: string, id: string) => {
      try {
        const { generation: g, message } = await api.generations.get(workspace.id, id);
        const outputs = g.outputs ?? [];
        patch(clientKey, (c) => ({ ...c, id: g.id, status: g.status, stage: (g.stage as GenerationStage) ?? c.stage, progress: g.progress, outputs, message }));
        await resolveUrls(
          clientKey,
          outputs.filter((o) => o.key).map((o) => o.key),
        );
      } catch {
        /* keep what we have */
      }
    },
    [workspace.id, patch, resolveUrls],
  );

  const watch = useCallback(
    (clientKey: string, id: string) => {
      if (streams.current.has(clientKey)) return;
      const es = new EventSource(api.generations.streamUrl(workspace.id, id));
      streams.current.set(clientKey, es);
      const close = () => {
        es.close();
        streams.current.delete(clientKey);
      };

      es.addEventListener('stage', (e) => {
        const ev = JSON.parse((e as MessageEvent).data) as Extract<GenerationEvent, { type: 'stage' }>;
        patch(clientKey, (c) => ({
          ...c,
          status: ev.stage === 'queued' ? 'QUEUED' : c.status === 'requesting' || c.status === 'QUEUED' ? 'RUNNING' : c.status,
          stage: ev.stage,
          progress: ev.progress,
          detail: ev.detail,
        }));
      });
      es.addEventListener('output', (e) => {
        const ev = JSON.parse((e as MessageEvent).data) as Extract<GenerationEvent, { type: 'output' }>;
        patch(clientKey, (c) => ({
          ...c,
          outputs: c.outputs.some((o) => o.key === ev.output.key && o.role === ev.output.role) ? c.outputs : [...c.outputs, ev.output as GenerationOutputRow],
        }));
        if (ev.output.key) void resolveUrls(clientKey, [ev.output.key]);
      });
      es.addEventListener('done', () => {
        close();
        void sync(clientKey, id).then(() => refreshBalance());
      });
      es.onerror = () => {
        // The browser will reconnect on its own; if it gives up, the row is still the truth.
        if (es.readyState === EventSource.CLOSED) {
          close();
          void sync(clientKey, id);
        }
      };
    },
    [workspace.id, patch, resolveUrls, sync, refreshBalance],
  );

  useEffect(
    () => () => {
      for (const es of streams.current.values()) es.close();
    },
    [],
  );

  /** Ask for a generation. The card exists before the request is answered. */
  const create = useCallback(
    async (input: { toolId: string; capability: string; params: Record<string, unknown>; credits: number; sourceKey?: string; costCode?: string }) => {
      const clientKey = crypto.randomUUID();
      const card: GenerationCard = {
        clientKey,
        id: null,
        toolId: input.toolId,
        capability: input.capability,
        credits: input.credits,
        status: 'requesting',
        stage: 'queued',
        progress: 0,
        outputs: [],
        urls: {},
        params: input.params,
        sourceKey: input.sourceKey,
        createdAt: Date.now(),
      };
      setCards((cs) => [card, ...cs].slice(0, MAX_CARDS));
      spend(input.credits);
      try {
        const { generation: g, balance } = await api.generations.create(workspace.id, {
          capability: input.capability,
          params: input.params,
          clientKey,
          costCode: input.costCode,
        });
        setBalance(balance);
        patch(clientKey, (c) => ({ ...c, id: g.id, status: g.status, credits: g.credits }));
        if (g.status === 'QUEUED' || g.status === 'RUNNING') watch(clientKey, g.id);
        else await sync(clientKey, g.id);
        return { ok: true as const, id: g.id };
      } catch (err) {
        void refreshBalance();
        const message =
          err instanceof ApiError
            ? err.status === 402
              ? 'Not enough credits for that.'
              : err.fields?.length
                ? err.fields.map((f) => f.message).join(' ')
                : err.message
            : 'Could not reach AnyStudio. Nothing was charged.';
        patch(clientKey, (c) => ({ ...c, status: 'FAILED', stage: 'failed', message }));
        return { ok: false as const, status: err instanceof ApiError ? err.status : 0, message };
      }
    },
    [workspace.id, spend, setBalance, patch, watch, sync, refreshBalance],
  );

  const cancel = useCallback(
    async (clientKey: string) => {
      const card = cards.find((c) => c.clientKey === clientKey);
      if (!card?.id) return;
      try {
        await api.generations.cancel(workspace.id, card.id);
        streams.current.get(clientKey)?.close();
        streams.current.delete(clientKey);
        patch(clientKey, (c) => ({ ...c, status: 'CANCELLED', stage: 'failed', message: 'Cancelled. Your credits are back.' }));
        void refreshBalance();
      } catch (err) {
        patch(clientKey, (c) => ({ ...c, message: err instanceof ApiError ? err.message : 'Could not cancel.' }));
      }
    },
    [cards, workspace.id, patch, refreshBalance],
  );

  const dismiss = useCallback((clientKey: string) => {
    streams.current.get(clientKey)?.close();
    streams.current.delete(clientKey);
    setCards((cs) => cs.filter((c) => c.clientKey !== clientKey));
  }, []);

  /** The seller changed a piece of copy by hand: keep it on the card and on the row. */
  const editText = useCallback(
    async (clientKey: string, field: string, value: string) => {
      const card = cards.find((c) => c.clientKey === clientKey);
      patch(clientKey, (c) => ({ ...c, outputs: c.outputs.map((o) => (o.role === 'text' ? { ...o, text: setPath(o.text, field, value) } : o)) }));
      if (card?.id) {
        try {
          await api.generations.editText(workspace.id, card.id, field, value);
        } catch {
          /* the card keeps the edit; the row catches up on the next save */
        }
      }
    },
    [cards, workspace.id, patch],
  );

  /**
   * Write one field again, for one credit. A small hidden generation is
   * created and polled to its end; the new text replaces the field on the
   * card and is saved to the row. The card's own stream is not involved.
   */
  const regenerateField = useCallback(
    async (clientKey: string, field: string, instruction: string): Promise<{ ok: boolean; message?: string }> => {
      const card = cards.find((c) => c.clientKey === clientKey);
      if (!card?.id) return { ok: false, message: 'Nothing to rewrite yet.' };
      const text = card.outputs.find((o) => o.role === 'text')?.text as Record<string, unknown> | undefined;
      const previous = String(getPath(text, field) ?? '');
      const p = card.params;
      spend(1);
      try {
        const { generation: g, balance } = await api.generations.create(workspace.id, {
          capability: 'TEXT_GENERATE',
          costCode: 'text.caption',
          clientKey: crypto.randomUUID(),
          params: {
            task: 'field',
            field,
            previous,
            instruction,
            productName: p.productName,
            price: p.price,
            language: p.language ?? 'en',
            sourceKey: card.sourceKey,
          },
        });
        setBalance(balance);
        const deadline = Date.now() + 90_000;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 1500));
          const { generation: row, message } = await api.generations.get(workspace.id, g.id);
          if (row.status === 'SUCCEEDED') {
            const out = (row.outputs ?? []).find((o) => o.role === 'text')?.text as { value?: string } | undefined;
            if (out?.value) {
              await editText(clientKey, field, out.value);
              return { ok: true };
            }
            return { ok: false, message: 'Nothing came back. Your credit is refunded.' };
          }
          if (row.status === 'FAILED' || row.status === 'CANCELLED') {
            void refreshBalance();
            return { ok: false, message: message ?? 'That did not work. Your credit is back.' };
          }
        }
        return { ok: false, message: 'That is taking too long. Check the library in a moment.' };
      } catch (err) {
        void refreshBalance();
        return { ok: false, message: err instanceof ApiError ? err.message : 'Could not reach AnyStudio.' };
      }
    },
    [cards, workspace.id, spend, setBalance, refreshBalance, editText],
  );

  /** Recent history on load, so a returning tab sees what it made. */
  const hydrate = useCallback(async () => {
    try {
      const rows = await api.generations.history(workspace.id);
      const recent = rows.slice(0, 12);
      const fromRow = (g: GenerationRow): GenerationCard => ({
        clientKey: g.id,
        id: g.id,
        toolId: g.capability === 'IMAGE_EDIT' && g.input.preserveProduct === false ? 'restyle' : toolFor(g.capability),
        capability: g.capability,
        credits: g.credits,
        status: g.status,
        stage: (g.stage as GenerationStage) ?? (g.status === 'SUCCEEDED' ? 'done' : g.status === 'QUEUED' ? 'queued' : 'generating'),
        progress: g.progress,
        outputs: g.outputs ?? [],
        urls: {},
        params: g.input,
        sourceKey: typeof g.input.sourceKey === 'string' ? g.input.sourceKey : undefined,
        createdAt: new Date(g.createdAt).getTime(),
      });
      setCards((cs) => {
        const known = new Set(cs.map((c) => c.id));
        return [...cs, ...recent.filter((g) => !known.has(g.id)).map(fromRow)].slice(0, MAX_CARDS);
      });
      for (const g of recent) {
        if (g.status === 'QUEUED' || g.status === 'RUNNING') watch(g.id, g.id);
        const keys = (g.outputs ?? []).filter((o) => o.key).map((o) => o.key);
        if (keys.length) void resolveUrls(g.id, keys);
      }
    } catch {
      /* an empty pane is fine */
    }
  }, [workspace.id, watch, resolveUrls]);

  /** Pay for the rest of a song. The server debits once however many times this is pressed. */
  const unlock = useCallback(
    async (clientKey: string): Promise<{ ok: boolean; status?: number; message?: string }> => {
      const card = cards.find((c) => c.clientKey === clientKey);
      if (!card?.id) return { ok: false, message: 'Not ready yet.' };
      try {
        const r = await api.audio.unlock(workspace.id, card.id);
        if (r.credits) spend(r.credits);
        const urls: Record<string, string> = {};
        for (const o of r.generation.outputs) if (o.key && o.url) urls[o.key] = o.url;
        patch(clientKey, (c) => ({ ...c, outputs: r.generation.outputs.map(({ url: _u, ...o }) => o), urls: { ...c.urls, ...urls } }));
        void refreshBalance();
        return { ok: true };
      } catch (e) {
        const err = e as { status?: number; message?: string };
        return { ok: false, status: err.status, message: err.message };
      }
    },
    [cards, workspace.id, spend, patch, refreshBalance],
  );

  return { cards, create, cancel, dismiss, hydrate, resolveUrls, editText, regenerateField, unlock };
}

export function toolFor(capability: string): string {
  return (
    (
      {
        IMAGE_EDIT: 'scene',
        BACKGROUND_REPLACE: 'background',
        BACKGROUND_REMOVE: 'cutout',
        UPSCALE: 'enhance',
        TEXT_GENERATE: 'copy',
        IMAGE_TO_VIDEO: 'video',
        IMAGE_GENERATE: 'flyer',
        MUSIC: 'music',
        VOICEOVER: 'voice',
        DUB: 'translate',
        LIPSYNC: 'lipsync',
      } as Record<string, string>
    )[capability] ?? 'scene'
  );
}

function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function setPath(obj: unknown, path: string, value: unknown): unknown {
  const root = structuredClone((obj ?? {}) as Record<string, unknown>);
  const parts = path.split('.');
  let cur = root;
  for (const part of parts.slice(0, -1)) {
    if (typeof cur[part] !== 'object' || cur[part] === null) cur[part] = {};
    cur = cur[part] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
  return root;
}
