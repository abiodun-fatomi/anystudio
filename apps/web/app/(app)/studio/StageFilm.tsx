'use client';
/**
 * The wait, made watchable.
 *
 * A generation used to be a grey rectangle with a bar over it. The bar was
 * honest — it moves on the worker's own progress, not a timer — but a grey
 * rectangle tells you nothing about what is being done to your photo, and a
 * seller watching one has no reason to believe anything is happening at all.
 *
 * So the photo becomes the animation. The frame holds the seller's own source
 * picture and works on it: a scan sweeps it while we are reading it, a cut-out
 * checker travels across it while the product is being lifted, the new ground
 * paints up from the bottom while the scene is being built, and the whole
 * thing settles when the outputs are being written.
 *
 * Two rules this component keeps, and they are the whole reason it is written
 * this way rather than as a twelve-second loop:
 *
 *   1. It shows the stage it is IN, not the stage a timer says it should be
 *      in. Each phase loops for as long as that phase actually lasts, so a
 *      slow provider looks slow. Nothing here advances on its own.
 *   2. It never claims to show the result. Everything drawn over the photo is
 *      obviously an instrument — a sweep, a grid, a wash — never a fake
 *      product on a fake background. The first real pixels a seller sees are
 *      the real ones.
 *
 * With no source photo (a caption, a voiceover, a song) the frame falls back
 * to its own surface and the same instruments play over it.
 */
import { useEffect, useState } from 'react';
import styles from './stagefilm.module.css';

/**
 * Seven pipeline stages, four things worth drawing.
 *
 * `queued` and `waiting` are both "nothing is being done to your photo yet",
 * and saying so honestly beats animating a machine that has not started.
 */
const PHASE = {
  queued: 'wait',
  waiting: 'wait',
  preparing: 'read',
  routing: 'read',
  generating: 'make',
  composing: 'make',
  storing: 'settle',
  done: 'settle',
  failed: 'settle',
} as const;

type Phase = (typeof PHASE)[keyof typeof PHASE];

export function StageFilm({
  stage,
  label,
  src,
  alt,
}: {
  /** The stage the worker last reported. Anything unrecognised draws as work in progress. */
  stage: string;
  /** The tool's words for this stage — ResultCard already has them; this component does not invent copy. */
  label: string;
  /** The seller's own source photo, when this generation has one and its URL has resolved. */
  src?: string;
  alt?: string;
}) {
  const phase: Phase = (PHASE as Record<string, Phase>)[stage] ?? 'make';
  /**
   * A source that will not load is not an error worth showing anyone — a
   * signed URL can expire, and a video source handed to an <img> never
   * decodes at all. Either way the frame falls back to its own surface, which
   * is the same thing a source-less generation gets.
   */
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);
  const photo = src && !broken ? src : undefined;

  return (
    <div className={styles.film} data-phase={phase} role="img" aria-label={label}>
      {photo ? <img className={styles.source} src={photo} alt={alt ?? ''} onError={() => setBroken(true)} /> : <div className={styles.source} aria-hidden />}

      {/* the new ground, once there is one */}
      <div className={styles.ground} aria-hidden />
      {/* transparency, left behind where the background has been lifted... */}
      <div className={styles.checker} aria-hidden />
      {/* ...and the edge doing the lifting */}
      <div className={styles.edge} aria-hidden />
      {/* measuring instruments over the top */}
      <div className={styles.grid} aria-hidden />
      <div className={styles.scan} aria-hidden />

      <div className={styles.foot} aria-hidden>
        <span className={styles.label}>{label}</span>
      </div>
    </div>
  );
}
