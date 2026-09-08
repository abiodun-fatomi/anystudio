import { describe, expect, it } from 'vitest';
import { rethrowIfAborted } from './abort';

describe('pipeline fallback cancellation guard', () => {
  it('throws the shared signal reason even when the caught error was wrapped', () => {
    const controller = new AbortController();
    const cancellation = new Error('generation cancelled');
    controller.abort(cancellation);

    expect(() => rethrowIfAborted(controller.signal, new Error('transport closed'))).toThrow(cancellation);
  });

  it('rethrows an AbortError even if the shared signal has not observed it', () => {
    const aborted = Object.assign(new Error('request aborted'), { name: 'AbortError' });

    expect(() => rethrowIfAborted(new AbortController().signal, aborted)).toThrow(aborted);
  });

  it('leaves ordinary fallback errors for the pipeline to handle', () => {
    expect(() => rethrowIfAborted(new AbortController().signal, new Error('optional helper unavailable'))).not.toThrow();
  });
});
