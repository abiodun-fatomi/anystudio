'use client';
/**
 * The proof column's centrepiece: the six-frame sheet a seller got back from
 * one phone photo. Frames 02–05 are true background replacements of frame 01
 * (same bottle, new studio), and frame 06 is the reel — which is why the copy
 * can promise "your product is never redrawn".
 *
 * Assets live in public/shots/ (see scripts/fetch-shots.sh); the CloudFront
 * links in design/assets.json are convenient for prototypes, not hosting.
 */
import { useRef, useState } from 'react';
import styles from '@/app/(auth)/auth.module.css';

const FRAMES = [
  { n: '02', src: '/shots/ravi-1.webp', art: 'linear-gradient(160deg,#FF9E6D,#D6006E 78%)', nm: 'Ravi', pr: '₦4,500' },
  { n: '03', src: '/shots/ravi-2.webp', art: 'linear-gradient(200deg,#1E2A4A,#00808F 90%)', nm: 'Ravi', pr: '₦4,500' },
  { n: '04', src: '/shots/bimbo.webp', art: 'linear-gradient(30deg,#F5D0A9,#C9455E 95%)', nm: 'Bimbo', pr: '₦18,000' },
  { n: '05', src: '/shots/kicks.webp', art: 'linear-gradient(20deg,#43261C,#FF9E6D 130%)', nm: 'Kicks', pr: '₦32,000' },
] as const;

export function SheetShowcase() {
  const [playing, setPlaying] = useState(false);
  const [videoFailed, setVideoFailed] = useState(false);
  const video = useRef<HTMLVideoElement>(null);

  return (
    <div className={styles.sheet} aria-label="Example product sheet">
      <div className={styles.sheetBar}>
        <span className="mono">Sheet 001 · Ravi Hair Oil</span>
        <span className="mono">6 frames</span>
      </div>
      <div className={styles.grid}>
        <div className={`${styles.frame} ${styles.src}`}>
          <div className={styles.art} style={{ background: 'linear-gradient(150deg,#b9a998,#6f6257)' }} />
          <img className={styles.ph} alt="" src="/shots/source.webp" loading="eager" />
          <span className={styles.fnum}>01</span>
          <span className={styles.badge}>Their photo</span>
        </div>

        {FRAMES.map((f) => (
          <div key={f.n} className={styles.frame}>
            <div className={styles.art} style={{ background: f.art }} />
            <img className={styles.ph} alt="" src={f.src} loading="eager" />
            <span className={styles.scrim} />
            <span className={styles.fnum}>{f.n}</span>
            <div className={styles.tag}>
              <span className={styles.nm}>{f.nm}</span>
              <span className={styles.pr}>{f.pr}</span>
            </div>
          </div>
        ))}

        <div className={`${styles.frame} ${playing ? styles.playing : ''}`}>
          <div className={styles.art} style={{ background: 'linear-gradient(140deg,#2B1B33,#D6006E 120%)' }} />
          <img className={styles.ph} alt="" src="/shots/reel-poster.webp" loading="eager" />
          {!videoFailed && (
            <video
              ref={video}
              className={styles.vd}
              autoPlay
              muted
              loop
              playsInline
              preload="auto"
              disablePictureInPicture
              onPlaying={() => setPlaying(true)}
              onError={() => {
                setVideoFailed(true);
                setPlaying(false);
              }}
            >
              <source src="/shots/reel.mp4" type="video/mp4" />
            </video>
          )}
          <span className={styles.scrim} />
          <span className={styles.fnum}>06</span>
          <span className={styles.live}>
            <i />
            Reel
          </span>
          <span className={styles.prog}>
            <i />
          </span>
        </div>
      </div>
    </div>
  );
}
