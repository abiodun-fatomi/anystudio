'use client';
/**
 * The photo at full size. The stage on the studio page is a fixed box that
 * shows the whole picture small; this is where someone checks the label, the
 * stitching, the thing they are about to pay to have restyled. Zoom with the
 * buttons, a pinch, or ⌘/Ctrl + wheel; drag or scroll to pan; double-click
 * flips between "fit the screen" and "actual pixels"; Esc closes.
 */
import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '@/components/shell/icons';
import styles from './lightbox.module.css';

const STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];
const MIN = STEPS[0]!;
const MAX = STEPS[STEPS.length - 1]!;

export function Lightbox({ src, alt, meta, onClose }: { src: string; alt: string; meta?: string; onClose: () => void }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  // null = fit to the screen; a number = scale against actual pixels
  const [zoom, setZoom] = useState<number | null>(null);
  const [fitScale, setFitScale] = useState(1);

  // What "fit" means depends on the window; keep it current.
  const measure = useCallback(() => {
    const el = scroller.current;
    if (!el || !natural) return;
    const pad = 32;
    setFitScale(Math.min(1, (el.clientWidth - pad) / natural.w, (el.clientHeight - pad) / natural.h));
  }, [natural]);
  useEffect(() => {
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [measure]);

  const scale = zoom ?? fitScale;
  const step = useCallback(
    (dir: 1 | -1) => {
      const next = dir > 0 ? STEPS.find((s) => s > scale + 0.001) : [...STEPS].reverse().find((s) => s < scale - 0.001);
      if (next !== undefined) setZoom(next);
    },
    [scale],
  );

  // Esc closes; the page behind does not scroll while this is up.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === '+' || e.key === '=') step(1);
      if (e.key === '-') step(-1);
      if (e.key === '0') setZoom(null);
      if (e.key === '1') setZoom(1);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, step]);
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // ⌘/Ctrl + wheel (and a trackpad pinch, which arrives the same way) zooms
  // around the pointer; a plain wheel scrolls, as it should. A native,
  // non-passive listener: React's own wheel handler is passive, so it could
  // not stop the browser zooming the whole page as well.
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const cur = scaleRef.current;
      const next = Math.min(8, Math.max(0.1, cur * Math.exp(-e.deltaY * 0.0025)));
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left + el.scrollLeft;
      const py = e.clientY - rect.top + el.scrollTop;
      setZoom(next);
      requestAnimationFrame(() => {
        el.scrollLeft = px * (next / cur) - (e.clientX - rect.left);
        el.scrollTop = py * (next / cur) - (e.clientY - rect.top);
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Drag to pan when the picture is bigger than the window.
  const drag = useRef<{ x: number; y: number; sl: number; st: number } | null>(null);
  const onMouseDown = (e: ReactMouseEvent) => {
    const el = scroller.current;
    if (!el || e.button !== 0) return;
    drag.current = { x: e.clientX, y: e.clientY, sl: el.scrollLeft, st: el.scrollTop };
    el.classList.add(styles.dragging!);
  };
  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = drag.current;
      const el = scroller.current;
      if (!d || !el) return;
      el.scrollLeft = d.sl - (e.clientX - d.x);
      el.scrollTop = d.st - (e.clientY - d.y);
    };
    const up = () => {
      drag.current = null;
      scroller.current?.classList.remove(styles.dragging!);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, []);

  const width = natural ? Math.round(natural.w * scale) : undefined;
  const pct = Math.round(scale * 100);

  return createPortal(
    <div className={styles.root} role="dialog" aria-modal="true" aria-label="Photo at full size">
      <div className={styles.bar}>
        <div className={styles.meta}>
          <span className={styles.name}>{alt}</span>
          {meta && <span className="mono">{meta}</span>}
        </div>
        <div className={styles.zoom} role="group" aria-label="Zoom">
          <button type="button" onClick={() => step(-1)} aria-label="Zoom out" disabled={scale <= MIN}>
            −
          </button>
          <button type="button" className={styles.pct} onClick={() => setZoom(zoom === null ? 1 : null)} title="Fit the screen / actual size">
            {pct}%
          </button>
          <button type="button" onClick={() => step(1)} aria-label="Zoom in" disabled={scale >= MAX}>
            +
          </button>
          <span className={styles.sep} />
          <button type="button" data-on={zoom === null || undefined} onClick={() => setZoom(null)}>
            Fit
          </button>
          <button type="button" data-on={zoom === 1 || undefined} onClick={() => setZoom(1)}>
            1:1
          </button>
        </div>
        <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
          <Icon.x width={18} height={18} />
        </button>
      </div>
      <div
        ref={scroller}
        className={styles.scroller}
        onMouseDown={onMouseDown}
        onDoubleClick={() => setZoom(zoom === null ? 1 : null)}
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <img
          src={src}
          alt={alt}
          draggable={false}
          style={width ? { width } : undefined}
          data-ready={natural ? 'true' : undefined}
          onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
        />
      </div>
      <div className={styles.hint} aria-hidden="true">
        Double-click for actual size · ⌘/Ctrl + scroll to zoom · Esc to close
      </div>
    </div>,
    document.body,
  );
}
