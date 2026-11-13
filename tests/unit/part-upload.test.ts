import { afterEach, describe, expect, it, vi } from 'vitest';
import { PartUploadError, uploadParts, type PutPart } from '@/lib/media/part-upload';
import { partCount, partRange } from '@/lib/media/video';

const PART = 5;
const file = (size: number) => new Blob([new Uint8Array(size).map((_, i) => i % 251)]);
const instant = () => 0;
const signAll = (calls: number[][] = []) => async (parts: number[]) => {
  calls.push(parts);
  return Object.fromEntries(parts.map((n) => [n, `https://r2.test/part/${n}`]));
};
const partOf = (url: string) => Number(url.split('/').pop());

/** A bucket that records what it was sent, failing on cue. */
function bucket(script: (n: number, attempt: number) => number = () => 200) {
  const received = new Map<number, number>();
  const tries = new Map<number, number>();
  const put: PutPart = async (url, body, onProgress) => {
    const n = partOf(url);
    const attempt = (tries.get(n) ?? 0) + 1;
    tries.set(n, attempt);
    const status = script(n, attempt);
    if (status >= 200 && status < 300) {
      onProgress(body.size);
      received.set(n, body.size);
    }
    return status;
  };
  return { put, received, tries };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('partCount and partRange', () => {
  it('cuts a file into equal parts and a shorter last one', () => {
    expect(partCount(12, 5)).toBe(3);
    expect(partRange(1, 12, 5)).toEqual({ start: 0, end: 5 });
    expect(partRange(3, 12, 5)).toEqual({ start: 10, end: 12 });
    expect(partCount(10, 5)).toBe(2);
    expect(partCount(1, 5)).toBe(1);
  });
});

describe('uploadParts', () => {
  it('sends every part once and reports the whole file as sent', async () => {
    const { put, received } = bucket();
    const progress: number[] = [];
    const calls: number[][] = [];
    await uploadParts({
      file: file(23),
      partSize: PART,
      sign: signAll(calls),
      put,
      backoff: instant,
      onProgress: (sent) => progress.push(sent),
    });
    expect([...received.keys()].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect([...received.values()].reduce((a, b) => a + b, 0)).toBe(23);
    expect(progress.at(-1)).toBe(23);
    expect(calls.flat().sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it('skips the parts the bucket already holds: a reload resumes', async () => {
    const { put, received } = bucket();
    const progress: number[] = [];
    await uploadParts({
      file: file(23),
      partSize: PART,
      done: [1, 2, 4],
      sign: signAll(),
      put,
      backoff: instant,
      onProgress: (sent) => progress.push(sent),
    });
    expect([...received.keys()].sort()).toEqual([3, 5]);
    // The resumed parts count from the first report.
    expect(progress[0]).toBe(15);
    expect(progress.at(-1)).toBe(23);
  });

  it('sends a part again after a dropped connection, and finishes', async () => {
    const { put, received, tries } = bucket((n, attempt) => (n === 2 && attempt < 3 ? 0 : 200));
    const waits: boolean[] = [];
    await uploadParts({
      file: file(12),
      partSize: PART,
      sign: signAll(),
      put,
      backoff: instant,
      onWaiting: (w) => waits.push(w),
    });
    expect(tries.get(2)).toBe(3);
    expect(received.size).toBe(3);
    expect(waits).toContain(true);
    expect(waits.at(-1)).toBe(false);
  });

  it('signs a part again when its URL is refused (expired)', async () => {
    const { put, received } = bucket((n, attempt) => (n === 1 && attempt === 1 ? 403 : 200));
    const calls: number[][] = [];
    await uploadParts({ file: file(10), partSize: PART, sign: signAll(calls), put, backoff: instant });
    expect(received.size).toBe(2);
    expect(calls.filter((batch) => batch[0] === 1).length).toBe(2);
  });

  it('stops at once on a refusal that retrying cannot fix', async () => {
    const { put } = bucket((n) => (n === 2 ? 400 : 200));
    await expect(
      uploadParts({ file: file(12), partSize: PART, sign: signAll(), put, backoff: instant }),
    ).rejects.toMatchObject({ name: 'PartUploadError', status: 400 });
  });

  it('gives up on a part after the last try, and says why', async () => {
    const { put, tries } = bucket((n) => (n === 1 ? 0 : 200));
    const error = await uploadParts({
      file: file(10),
      partSize: PART,
      sign: signAll(),
      put,
      backoff: instant,
      attempts: 4,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PartUploadError);
    expect((error as Error).message).toContain('after 4 tries');
    expect(tries.get(1)).toBe(4);
  });

  it('stops when the teacher cancels', async () => {
    const controller = new AbortController();
    const put: PutPart = async () => {
      controller.abort();
      return -1;
    };
    await expect(
      uploadParts({
        file: file(10),
        partSize: PART,
        sign: signAll(),
        put,
        backoff: instant,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ status: -1 });
  });

  it('waits while offline without using up the tries', async () => {
    const net = { onLine: false };
    vi.stubGlobal('navigator', net);
    const { put, tries } = bucket();
    let release: () => void = () => {};
    const online = () =>
      new Promise<void>((resolve) => {
        release = () => {
          net.onLine = true;
          resolve();
        };
      });
    const waits: boolean[] = [];
    const run = uploadParts({
      file: file(5),
      partSize: PART,
      sign: signAll(),
      put,
      backoff: instant,
      attempts: 1,
      online,
      onWaiting: (w) => waits.push(w),
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(tries.size).toBe(0);
    expect(waits).toEqual([true]);
    release();
    await run;
    expect(tries.get(1)).toBe(1);
    expect(waits).toEqual([true, false]);
  });
});
