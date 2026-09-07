'use client';
/**
 * Every look, findable.
 *
 * The panel used to list the whole catalogue inline. At seventeen looks that
 * was already a long scroll; at forty-two it is the tool-strip mistake all
 * over again — a wall, not a menu. So the panel keeps the first few of each
 * group, the ones most people tap, and this is the door to the rest.
 *
 * Searched, not scrolled. A seller does not think "lifestyle, third row" —
 * they think "owambe", "jollof", "wig", "by the yard". Typing any of those
 * gets there faster than any amount of scrolling, which is why the box takes
 * the cursor on open.
 *
 * Deliberately the same shape as the tool sheet: a merchant learns one
 * gesture and it works in both places.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { PRESET_GROUPS, searchPresets, type PhotoPreset, type PresetGroup } from '@anystudio/shared';
import { Icon } from '@/components/shell/icons';
import styles from './studio.module.css';

export function PresetSheet({ current, onPick, onClose }: { current: string | null; onPick: (p: PhotoPreset) => void; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const box = useRef<HTMLInputElement>(null);
  const found = useMemo(() => searchPresets(query), [query]);

  useEffect(() => {
    box.current?.focus();
  }, []);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);

  const groups = (Object.keys(PRESET_GROUPS) as PresetGroup[])
    .map((g) => [g, found.filter((p) => p.group === g)] as const)
    .filter(([, list]) => list.length > 0);

  return (
    <div className={styles.sheetWrap} role="dialog" aria-modal="true" aria-label="All looks">
      <button type="button" className={styles.sheetScrim} aria-label="Close" onClick={onClose} />
      <div className={styles.sheet}>
        <div className={styles.sheetHead}>
          <input
            ref={box}
            type="search"
            className={styles.sheetSearch}
            placeholder="What should it look like? Try “owambe”, “kitchen”, “marble”…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search the looks"
          />
          <button type="button" className={styles.sheetClose} onClick={onClose} aria-label="Close">
            <Icon.x />
          </button>
        </div>

        <div className={styles.sheetBody}>
          {groups.length === 0 && (
            <p className={styles.sheetEmpty}>
              Nothing matches “{query}”. Try where the photo should be taken rather than what it is called — “kitchen”, “market”, “plain white”.
            </p>
          )}
          {groups.map(([g, list]) => (
            <section key={g}>
              <div className={styles.sheetGroup}>
                <strong>{PRESET_GROUPS[g].label}</strong>
                <span>{PRESET_GROUPS[g].note}</span>
              </div>
              <div className={styles.presetRow}>
                {list.map((p) => (
                  <button
                    key={p.key}
                    type="button"
                    role="radio"
                    aria-checked={p.key === current}
                    className={styles.preset}
                    onClick={() => onPick(p)}
                    title={`${p.name} — ${p.note}`}
                  >
                    <span
                      className={styles.presetSwatch}
                      data-transparent={p.swatch.transparent || undefined}
                      style={
                        p.swatch.transparent
                          ? undefined
                          : {
                              background:
                                p.swatch.colors.length === 2 ? `linear-gradient(160deg, ${p.swatch.colors[0]}, ${p.swatch.colors[1]})` : p.swatch.colors[0],
                            }
                      }
                    >
                      <span className={styles.presetProduct} data-ink={p.swatch.ink} />
                    </span>
                    <span className={styles.presetName}>{p.name}</span>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
