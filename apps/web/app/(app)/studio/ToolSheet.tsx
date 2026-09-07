'use client';
/**
 * Everything the studio can do, findable.
 *
 * The strip could hold six tools comfortably and was carrying fifteen. A
 * merchant does not scan a toolbar reading labels — they arrive already
 * knowing what they want ("put it on a model", "get the wrinkles out", "do
 * all forty of them") and the job of this screen is to be the shortest path
 * from that sentence to that button.
 *
 * So it is searched, not scanned. Type "wrinkle" and Merchant shots comes up,
 * because nobody calls it ironing. Type "yoruba" and Translate comes up. The
 * groups are there for the person who does not know what they want yet, and
 * every card carries the sentence that says what it is for and what it costs.
 *
 * A tool that needs a photo, when there is no photo, is shown greyed with the
 * reason rather than hidden — someone looking for it should find it and learn
 * why it is not available, not conclude the product cannot do it.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { TOOL_GROUPS, TOOL_META, searchTools, type Tool, type ToolGroup, type ToolId } from '@/lib/studio/tools';
import { Icon } from '@/components/shell/icons';
import styles from './studio.module.css';

export function ToolSheet({ current, hasSource, onPick, onClose }: { current: ToolId; hasSource: boolean; onPick: (id: ToolId) => void; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const box = useRef<HTMLInputElement>(null);
  const found = useMemo(() => searchTools(query), [query]);

  // Open with the cursor in the search box: the fastest route is typing.
  useEffect(() => {
    box.current?.focus();
  }, []);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);

  const groups = (Object.keys(TOOL_GROUPS) as ToolGroup[])
    .map((g) => [g, found.filter((t) => TOOL_META[t.id].group === g)] as const)
    .filter(([, list]) => list.length > 0);

  return (
    <div className={styles.sheetWrap} role="dialog" aria-modal="true" aria-label="All tools">
      <button type="button" className={styles.sheetScrim} aria-label="Close" onClick={onClose} />
      <div className={styles.sheet}>
        <div className={styles.sheetHead}>
          <input
            ref={box}
            type="search"
            className={styles.sheetSearch}
            placeholder="What do you want to make? Try “model”, “wrinkle”, “song”…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search the tools"
          />
          <button type="button" className={styles.sheetClose} onClick={onClose} aria-label="Close">
            <Icon.x />
          </button>
        </div>

        <div className={styles.sheetBody}>
          {groups.length === 0 && (
            <p className={styles.sheetEmpty}>Nothing matches “{query}”. Try the thing you want rather than the tool — “mannequin”, “caption”, “all of them”.</p>
          )}
          {groups.map(([g, list]) => (
            <section key={g}>
              <div className={styles.sheetGroup}>
                <strong>{TOOL_GROUPS[g].label}</strong>
                <span>{TOOL_GROUPS[g].note}</span>
              </div>
              <div className={styles.sheetGrid}>
                {list.map((t) => (
                  <ToolCard key={t.id} tool={t} current={current} hasSource={hasSource} onPick={onPick} />
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

function ToolCard({ tool, current, hasSource, onPick }: { tool: Tool; current: ToolId; hasSource: boolean; onPick: (id: ToolId) => void }) {
  const blocked = tool.needsSource && !hasSource;
  return (
    <button
      type="button"
      className={styles.sheetCard}
      aria-pressed={tool.id === current}
      disabled={blocked}
      onClick={() => onPick(tool.id)}
      title={blocked ? 'Add a photo first' : tool.label}
    >
      <span className={styles.sheetIcon}>{Icon[tool.icon]({})}</span>
      <span className={styles.sheetText}>
        <strong>{tool.label}</strong>
        <span>{blocked ? 'Add a photo first — then this one is ready.' : TOOL_META[tool.id].blurb}</span>
      </span>
    </button>
  );
}
