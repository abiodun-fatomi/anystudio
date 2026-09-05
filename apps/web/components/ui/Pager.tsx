'use client';
/**
 * Cursor paging that feels like pages.
 *
 * The API pages by cursor (cheap, stable under inserts); people think in
 * pages. `useCursorPages` keeps a stack of the cursor each visited page
 * started at, so Older is a push and Newer a pop, and a size change goes
 * back to page one. `<Pager>` is the bar under a table: rows per page,
 * "Page n · k rows", Newer / Older. One shape for every list in the app.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from './Button';
import { Select } from './Field';
import { Pagination } from './Display';

export const PAGE_SIZES = [25, 50, 100] as const;

export interface CursorPage<T> {
  rows: T[];
  nextCursor: string | null;
}

export function useCursorPages<T>(fetchPage: (cursor: string | null, take: number) => Promise<CursorPage<T>>, opts: { size?: number; deps?: unknown[] } = {}) {
  const [size, setSize] = useState(opts.size ?? 50);
  const [rows, setRows] = useState<T[] | null>(null);
  const [stack, setStack] = useState<Array<string | null>>([null]);
  const [next, setNext] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;
  const sizeRef = useRef(size);
  sizeRef.current = size;

  const load = useCallback(async (cursor: string | null, take: number) => {
    setBusy(true);
    try {
      const r = await fetchRef.current(cursor, take);
      setRows(Array.isArray(r?.rows) ? r.rows : []);
      setNext(typeof r?.nextCursor === 'string' ? r.nextCursor : null);
    } catch {
      setRows((cur) => cur ?? []);
    } finally {
      setBusy(false);
    }
  }, []);

  /** Page one, fresh — after a search, a filter change, a mutation. */
  const reset = useCallback(async () => {
    setStack([null]);
    setRows(null);
    await load(null, sizeRef.current);
  }, [load]);

  const depsKey = JSON.stringify(opts.deps ?? []);
  useEffect(() => {
    void reset();
  }, [reset, depsKey]);

  /** The same page again — a background refresh that must not lose the person's place. */
  const reload = useCallback(async () => {
    await load(stack[stack.length - 1] ?? null, sizeRef.current);
  }, [load, stack]);

  const older = useCallback(async () => {
    if (!next) return;
    setStack((st) => [...st, next]);
    await load(next, sizeRef.current);
  }, [next, load]);
  const newer = useCallback(async () => {
    if (stack.length < 2) return;
    const st = stack.slice(0, -1);
    setStack(st);
    await load(st[st.length - 1] ?? null, sizeRef.current);
  }, [stack, load]);
  const changeSize = useCallback(
    async (n: number) => {
      setSize(n);
      setStack([null]);
      await load(null, n);
    },
    [load],
  );

  return { rows, busy, size, page: stack.length, hasOlder: next !== null, hasNewer: stack.length > 1, older, newer, changeSize, reset, reload };
}

export function Pager({
  page,
  count,
  noun = 'rows',
  size,
  hasOlder,
  hasNewer,
  busy,
  onOlder,
  onNewer,
  onSize,
  olderLabel = 'Older',
  newerLabel = 'Newer',
}: {
  page: number;
  count: number;
  noun?: string;
  size: number;
  hasOlder: boolean;
  hasNewer: boolean;
  busy?: boolean;
  onOlder: () => void;
  onNewer: () => void;
  onSize: (n: number) => void;
  olderLabel?: string;
  newerLabel?: string;
}) {
  return (
    <Pagination>
      <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-3)', flexWrap: 'wrap' }}>
        <span>
          Page {page} · {count} {count === 1 ? noun.replace(/s$/, '') : noun}
        </span>
        <Select
          aria-label="Rows per page"
          value={String(size)}
          onChange={(e) => onSize(Number(e.target.value))}
          options={PAGE_SIZES.map((n) => ({ value: String(n), label: `${n} per page` }))}
          disabled={busy}
          style={{ minWidth: 0 }}
        />
      </span>
      <span style={{ display: 'flex', gap: 'var(--s-2)' }}>
        <Button variant="ghost" size="sm" onClick={onNewer} disabled={!hasNewer || busy}>
          {newerLabel}
        </Button>
        <Button variant="ghost" size="sm" onClick={onOlder} disabled={!hasOlder || busy} loading={busy}>
          {olderLabel}
        </Button>
      </span>
    </Pagination>
  );
}
