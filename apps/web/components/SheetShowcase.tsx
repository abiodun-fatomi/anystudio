'use client';
/**
 * The proof column's centrepiece: the six-frame sheet a seller got back from
 * one phone photo.
 *
 * Frame 01 is the photo they sent. 02–04 are the same toy in three new
 * studios, 05 is the reel and 06 is the UGC ad — so the sheet shows the two
 * things a background swap cannot: something that moves, and something that
 * does not look like an advert.
 *
 * Every frame is the SAME toy. That matters more here than anywhere else on
 * the site, because this sheet sits beside the sign-in form under a promise
 * that we never redraw your product. It has been wrong twice: once with a
 * handbag and a trainer under a heading naming one product, and once with
 * hair-oil frames that were each generated separately and so carried
 * different printed labels. Everything here comes from one source photo,
 * with the rest derived from it as a reference image.
 *
 * Assets live in public/shots/ and must be COMMITTED, not merely present:
 * a deploy ships what git has, and a sheet whose files were only staged
 * renders as six gradient placeholders.
 */
import { useRef, useState } from 'react';
import styles from '@/app/(auth)/auth.module.css';

const NAME = 'Ládé Toys';
const PRICE = '$32';

const FRAMES = [
  { n: '02', src: '/shots/toy-peach.webp', art: 'linear-gradient(160deg,#FF9E6D,#D6006E 78%)', alt: 'The same toy on a soft peach studio backdrop' },
  { n: '03', src: '/shots/toy-teal.webp', art: 'linear-gradient(200deg,#1E2A4A,#00808F 90%)', alt: 'The same toy on a deep teal backdrop' },
  { n: '04', src: '/shots/toy-white.webp', art: 'linear-gradient(200deg,#F2EFEA,#CFC7BD 90%)', alt: 'The same toy on a plain white sweep' },
] as const;

export function SheetShowcase() {
  const [playing, setPlaying] = useState(false);
  const [reelFailed, setReelFailed] = useState(false);
  const [ugcFailed, setUgcFailed] = useState(false);
  const reel = useRef<HTMLVideoElement>(null);

  return (
    <div className={styles.sheet} aria-label="Example product sheet">
      <div className={styles.sheetBar}>
        <span className="mono">Sheet 001 · {NAME}</span>
        <span className="mono">6 frames</span>
      </div>
      <div className={styles.grid}>
        <div className={`${styles.frame} ${styles.src}`}>
          <div className={styles.art} style={{ background: 'linear-gradient(150deg,#b9a998,#6f6257)' }} />
          <img className={styles.ph} alt="A wooden stacking toy photographed at home on a kitchen table" src="/shots/toy-source.webp" loading="eager" />
          <span className={styles.fnum}>01</span>
          <span className={styles.badge}>Their photo</span>
        </div>

        {FRAMES.map((f) => (
          <div key={f.n} className={styles.frame}>
            <div className={styles.art} style={{ background: f.art }} />
            <img className={styles.ph} alt={f.alt} src={f.src} loading="eager" />
            <span className={styles.scrim} />
            <span className={styles.fnum}>{f.n}</span>
            <div className={styles.tag}>
              <span className={styles.nm}>{NAME}</span>
              <span className={styles.pr}>{PRICE}</span>
            </div>
          </div>
        ))}

        <div className={`${styles.frame} ${playing ? styles.playing : ''}`}>
          <div className={styles.art} style={{ background: 'linear-gradient(140deg,#2B1B33,#D6006E 120%)' }} />
          <img className={styles.ph} alt="" src="/shots/toy-peach.webp" loading="eager" />
          {!reelFailed && (
            <video
              ref={reel}
              className={styles.vd}
              autoPlay
              muted
              loop
              playsInline
              preload="auto"
              disablePictureInPicture
              aria-label="The same toy in a five-second reel"
              onPlaying={() => setPlaying(true)}
              onError={() => {
                setReelFailed(true);
                setPlaying(false);
              }}
            >
              <source src="/shots/toy-reel.mp4" type="video/mp4" />
            </video>
          )}
          <span className={styles.scrim} />
          <span className={styles.fnum}>05</span>
          <span className={styles.live}>
            <i />
            Reel
          </span>
          <span className={styles.prog}>
            <i />
          </span>
        </div>

        {/* An advert that does not move is a photograph. This one plays too —
            and unlike the reel its badge does not wait for playback, because
            the still alone is already the ad. */}
        <div className={styles.frame}>
          <div className={styles.art} style={{ background: 'linear-gradient(20deg,#43261C,#FF9E6D 130%)' }} />
          <img className={styles.ph} alt="The same toy held up to the camera, filmed the way a customer would" src="/shots/toy-ugc.webp" loading="eager" />
          {!ugcFailed && (
            <video
              className={styles.vd}
              autoPlay
              muted
              loop
              playsInline
              preload="metadata"
              disablePictureInPicture
              onError={() => setUgcFailed(true)}
            >
              <source src="/shots/toy-ugc.mp4" type="video/mp4" />
            </video>
          )}
          <span className={styles.scrim} />
          <span className={styles.fnum}>06</span>
          <span className={styles.ugc}>UGC ad</span>
          <div className={styles.tag}>
            <span className={styles.nm}>{NAME}</span>
            <span className={styles.pr}>{PRICE}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
