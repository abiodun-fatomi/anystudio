/**
 * The guided tour, shared by all three portals.
 *
 * Server-backed: it asks the API what is owed, so it runs once per person per
 * surface and never again on a second device. Nothing about "have they seen it"
 * lives in the browser.
 *
 * Accessibility is not a later pass here. A tour is a modal that appears
 * unbidden over the whole product, so if it traps focus or ignores Escape it is
 * strictly worse than not shipping it. Escape skips, Tab is confined to the
 * card, focus returns where it came from, and reduced-motion removes the
 * movement rather than the tour.
 */

'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { TourDefinition, TourStep } from '@anystudio/shared';

type Rect = { top: number; left: number; width: number; height: number };

async function api(path: string, body?: unknown) {
  return fetch(`/api/onboarding/${path}`, {
    method: body ? 'POST' : 'GET',
    credentials: 'include',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

export function GuidedTour() {
  const [tour, setTour] = useState<TourDefinition | null>(null);
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const returnFocusTo = useRef<Element | null>(null);

  // What does this person owe? The server decides; the client never guesses.
  useEffect(() => {
    let live = true;
    api('pending')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!live || !d?.tour) return;
        returnFocusTo.current = document.activeElement;
        setTour(d.tour);
        setIndex(d.stepIndex ?? 0);
      })
      .catch(() => {
        /* onboarding is a nicety — never block the app on it */
      });
    return () => {
      live = false;
    };
  }, []);

  const step: TourStep | undefined = tour?.steps[index];

  /**
   * Measure the target. useLayoutEffect so the spotlight is positioned in the
   * same frame the card appears — measuring in useEffect shows the card at the
   * old position for one frame, which reads as a jump.
   */
  useLayoutEffect(() => {
    if (!step) return;
    const measure = () => {
      if (!step.target) return setRect(null);
      const el = document.querySelector(step.target);
      if (!el) return setRect(null); // target missing: fall back to a centred card
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      const r = el.getBoundingClientRect();
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [step]);

  const finish = useCallback(
    (outcome: 'SKIPPED' | 'COMPLETED') => {
      // Written immediately, not after the exit animation. Someone who presses
      // skip has been unambiguous; showing it again because a request was still
      // in flight would be the rudest possible bug.
      if (tour) void api('finish', { tourKey: tour.key, outcome });
      setTour(null);
      (returnFocusTo.current as HTMLElement | null)?.focus?.();
    },
    [tour],
  );

  const go = useCallback(
    (next: number) => {
      if (!tour) return;
      if (next >= tour.steps.length) return finish('COMPLETED');
      setIndex(next);
      void api('progress', { tourKey: tour.key, stepIndex: next });
    },
    [tour, finish],
  );

  // Escape always skips, and Tab is confined to the card while it is open.
  useEffect(() => {
    if (!tour) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return finish('SKIPPED');
      if (e.key === 'ArrowRight') return go(index + 1);
      if (e.key === 'ArrowLeft' && index > 0) return go(index - 1);
      if (e.key !== 'Tab') return;
      const focusables = cardRef.current?.querySelectorAll<HTMLElement>('button, [href]');
      if (!focusables?.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    cardRef.current?.querySelector<HTMLElement>('button')?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [tour, index, go, finish]);

  if (!tour || !step) return null;

  const last = index === tour.steps.length - 1;
  const pad = 8;

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="tour-title" aria-describedby="tour-body" className="tour-root">
      {/* The scrim is one element with a cut-out, rather than four positioned
          strips — fewer moving parts, and it animates as one shape. */}
      <div
        className="tour-scrim"
        style={
          rect
            ? {
                clipPath: `polygon(0% 0%, 0% 100%, ${rect.left - pad}px 100%,
                  ${rect.left - pad}px ${rect.top - pad}px,
                  ${rect.left + rect.width + pad}px ${rect.top - pad}px,
                  ${rect.left + rect.width + pad}px ${rect.top + rect.height + pad}px,
                  ${rect.left - pad}px ${rect.top + rect.height + pad}px,
                  ${rect.left - pad}px 100%, 100% 100%, 100% 0%)`,
              }
            : undefined
        }
        onClick={() => finish('SKIPPED')}
      />

      {rect && (
        <div
          className="tour-ring"
          style={{
            top: rect.top - pad,
            left: rect.left - pad,
            width: rect.width + pad * 2,
            height: rect.height + pad * 2,
          }}
          aria-hidden="true"
        />
      )}

      <div
        ref={cardRef}
        className="tour-card"
        data-placement={rect ? (step.placement ?? 'bottom') : 'center'}
        style={rect ? positionFor(rect, step.placement ?? 'bottom') : undefined}
      >
        <div className="tour-meta">
          <span>
            Step {index + 1} of {tour.steps.length}
          </span>
          {/* Skip is present on every step, at the same size as everything else.
              Hiding it, or shrinking it, is a dark pattern. */}
          <button type="button" onClick={() => finish('SKIPPED')} className="tour-skip">
            Skip
          </button>
        </div>

        <h2 id="tour-title" className="tour-title">
          {step.title}
        </h2>
        <p id="tour-body" className="tour-body">
          {step.body}
        </p>

        <div className="tour-actions">
          <div className="tour-dots" aria-hidden="true">
            {tour.steps.map((s, i) => (
              <i key={s.id} data-on={i <= index} />
            ))}
          </div>
          {index > 0 && (
            <button type="button" className="tour-btn ghost" onClick={() => go(index - 1)}>
              Back
            </button>
          )}
          <button type="button" className="tour-btn" onClick={() => go(index + 1)}>
            {last ? 'Got it' : 'Next'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Keep the card on screen: flip a placement that would run past an edge. */
function positionFor(r: Rect, placement: string): React.CSSProperties {
  const gap = 14;
  const cardW = 340;
  const fitsBelow = r.top + r.height + gap + 200 < window.innerHeight;
  const p = placement === 'bottom' && !fitsBelow ? 'top' : placement;

  switch (p) {
    case 'top':
      return { top: r.top - gap, left: clampX(r.left + r.width / 2 - cardW / 2), transform: 'translateY(-100%)' };
    case 'left':
      return { top: r.top, left: Math.max(16, r.left - gap - cardW) };
    case 'right':
      return { top: r.top, left: clampX(r.left + r.width + gap) };
    default:
      return { top: r.top + r.height + gap, left: clampX(r.left + r.width / 2 - cardW / 2) };
  }
  function clampX(x: number) {
    return Math.min(Math.max(16, x), window.innerWidth - cardW - 16);
  }
}
