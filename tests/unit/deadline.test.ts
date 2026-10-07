import { describe, expect, it, vi } from 'vitest';
import { abortAfter, withDeadline } from '../../src/lib/media/deadline';

/**
 * The two ways an operation is stopped from hanging forever: a promise that
 * must answer by a deadline, and an abort signal that fires on its own.
 */
describe('a deadline on a promise', () => {
  it('passes the value through when it arrives in time', async () => {
    await expect(withDeadline(Promise.resolve('ok'), 1000, 'the call')).resolves.toBe('ok');
  });

  it('rejects with the label when the call never answers', async () => {
    vi.useFakeTimers();
    try {
      const pending = withDeadline(new Promise<never>(() => {}), 30_000, 'the call');
      const assertion = expect(pending).rejects.toThrow('the call timed out after 30s');
      await vi.advanceTimersByTimeAsync(30_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('propagates the call’s own failure untouched', async () => {
    await expect(
      withDeadline(Promise.reject(new Error('HTTP 500')), 1000, 'the call'),
    ).rejects.toThrow('HTTP 500');
  });
});

describe('an abort signal that fires on its own', () => {
  it('fires after its deadline when the browser has no native helper', async () => {
    const native = AbortSignal.timeout;
    Object.defineProperty(AbortSignal, 'timeout', { value: undefined, configurable: true });
    vi.useFakeTimers();
    try {
      const signal = abortAfter(1000);
      expect(signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1000);
      expect(signal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
      Object.defineProperty(AbortSignal, 'timeout', { value: native, configurable: true });
    }
  });

  it('uses the native helper when it exists', () => {
    const signal = abortAfter(1000);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
  });
});
