'use client';
/**
 * Pick a setting by looking at a photograph of it.
 *
 * The looks sheet next door is searched, because a look is a word — "owambe",
 * "marble", "plain white" — and typing it beats scrolling. A template is not
 * a word. It is a room, and the only honest way to choose between two rooms
 * is to see them both. So this sheet is browsed rather than searched: chips
 * across the top narrow to what the seller is actually selling, and
 * everything below is a picture.
 *
 * The chips come first for the same reason the categories are merchandise and
 * not settings: a seller cannot tell you whether they want "on a surface",
 * but they can tell you instantly that they have a dress. One tap and the
 * grid is only ever a dozen tiles, which is a menu. All of them at once is a
 * wall.
 *
 * A search box is still here, under the chips, because somebody will know the
 * word — "living room", "banana leaf" — and making them hunt through chips
 * for a thing they can name is its own small insult. Searching clears the
 * chip, because a query that only looks inside one category would silently
 * hide the match and look broken.
 *
 * Tiles fall back to their gradient when a template has no render yet. That
 * is not a placeholder we are tolerating — it is what lets the catalogue ship
 * before the photography is finished and lets one bad render be deleted
 * without blanking a chip.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { TEMPLATE_CATEGORIES, searchTemplates, templateCategoriesPresent, type TemplateCategory, type TemplateView } from '@anystudio/shared';
import { Icon } from '@/components/shell/icons';
import styles from './studio.module.css';

export function TemplateSheet({
  templates,
  current,
  onPick,
  onClose,
}: {
  templates: TemplateView[];
  current: string | null;
  onPick: (t: TemplateView) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  /**
   * Opens on the category of whatever is already chosen, so somebody
   * reopening the sheet lands where they left off rather than at the top of
   * an unrelated chip. Null is "All".
   */
  const [category, setCategory] = useState<TemplateCategory | null>(() => templates.find((t) => t.code === current)?.category ?? null);
  const box = useRef<HTMLInputElement>(null);

  const categories = useMemo(() => templateCategoriesPresent(templates), [templates]);
  const found = useMemo(() => {
    const matched = searchTemplates(templates, query);
    return category && !query.trim() ? matched.filter((t) => t.category === category) : matched;
  }, [templates, query, category]);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);

  return (
    <div className={styles.sheetWrap} role="dialog" aria-modal="true" aria-label="Templates">
      <button type="button" className={styles.sheetScrim} aria-label="Close" onClick={onClose} />
      <div className={styles.sheet}>
        <div className={styles.sheetHead}>
          <input
            ref={box}
            type="search"
            className={styles.sheetSearch}
            placeholder="Search templates — “living room”, “marble”, “banana leaf”…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              // A query that only searched inside one chip would hide the
              // match and read as a broken search.
              if (e.target.value.trim()) setCategory(null);
            }}
            aria-label="Search the templates"
          />
          <button type="button" className={styles.sheetClose} onClick={onClose} aria-label="Close">
            <Icon.x />
          </button>
        </div>

        <div className={styles.chipRow} role="tablist" aria-label="Template categories">
          <button
            type="button"
            role="tab"
            aria-selected={category === null}
            className={styles.chip}
            data-on={category === null || undefined}
            onClick={() => {
              setCategory(null);
              setQuery('');
            }}
          >
            All
          </button>
          {categories.map((c) => (
            <button
              key={c}
              type="button"
              role="tab"
              aria-selected={category === c}
              className={styles.chip}
              data-on={category === c || undefined}
              onClick={() => {
                setCategory(c);
                setQuery('');
              }}
            >
              {TEMPLATE_CATEGORIES[c].label}
            </button>
          ))}
        </div>

        <div className={styles.sheetBody}>
          {found.length === 0 && (
            <p className={styles.sheetEmpty}>
              {query.trim()
                ? `Nothing matches “${query}”. Try where the photo should be taken — “kitchen”, “street”, “studio”.`
                : 'Nothing here yet. Another category will have something.'}
            </p>
          )}
          <div className={styles.templateGrid}>
            {found.map((t) => (
              <TemplateTile key={t.code} template={t} chosen={t.code === current} onPick={() => onPick(t)} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * One tile.
 *
 * `broken` exists because a signed URL can expire while a sheet is open, and
 * an image that fails to load leaves a torn-icon hole where a room should
 * be. Falling back to the same gradient the template already carries turns
 * that into a tile that merely looks plainer than its neighbours — still
 * tappable, still labelled, still the right template.
 */
export function TemplateTile({ template, chosen, onPick }: { template: TemplateView; chosen: boolean; onPick: () => void }) {
  const [broken, setBroken] = useState(false);
  const showPhoto = Boolean(template.thumbnailUrl) && !broken;
  const { colors } = template.swatch;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={chosen}
      className={styles.template}
      data-chosen={chosen || undefined}
      onClick={onPick}
      title={`${template.name} — ${template.note}`}
    >
      <span
        className={styles.templateShot}
        style={showPhoto ? undefined : { background: colors.length === 2 ? `linear-gradient(160deg, ${colors[0]}, ${colors[1]})` : colors[0] }}
      >
        {showPhoto ? (
          <img src={template.thumbnailUrl!} alt="" loading="lazy" decoding="async" onError={() => setBroken(true)} />
        ) : (
          // The same stand-in the looks tiles use, so a template waiting for
          // its render still reads as a photo and not a colour chip.
          <span className={styles.presetProduct} data-ink={template.swatch.ink} />
        )}
      </span>
      <span className={styles.templateName}>{template.name}</span>
      <span className={styles.templateNote}>{template.note}</span>
    </button>
  );
}
