/**
 * Is ffmpeg on this machine?
 *
 * The audio and video pipelines shell out to ffmpeg, so the tests that cover
 * them make real audio and read real durations — which is the right way to
 * test them, and useless on a laptop that has never installed it.
 *
 * Without this, a developer who has just cloned the repository runs the suite
 * and gets five red lines about lip-sync and presenters, none of which are
 * about anything they did. A red suite that is red for a reason unrelated to
 * your change is worse than no suite: it teaches people to ignore it.
 *
 * So these specs skip when ffmpeg is absent, exactly as the database specs
 * already skip when DATABASE_URL is unset. CI installs ffmpeg, so the cover
 * is never actually lost — it just stops being a local papercut.
 */
import { spawnSync } from 'node:child_process';

/** True when `ffmpeg` can actually be run, not merely when a path exists. */
export const HAS_FFMPEG = ((): boolean => {
  try {
    return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
})();

/**
 * Say why the suite was skipped, once, rather than leaving someone to wonder
 * whether the tests are missing or merely quiet.
 */
if (!HAS_FFMPEG && !process.env.CI) console.warn('\n  ffmpeg is not installed, so the audio and video specs are skipped. `brew install ffmpeg` to run them.\n');
