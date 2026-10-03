import { describe, expect, it } from 'vitest';
import { sniffVideo, checkVideo, formatBytes, MAX_VIDEO_BYTES } from '@/lib/media/video';
import { resolveVideoUpdate } from '@/lib/content/video';

const mp4 = (brand = 'isom') =>
  new Uint8Array([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, ...[...brand].map((c) => c.charCodeAt(0))]);
const webm = () => new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00]);

describe('sniffVideo', () => {
  it('recognises MP4 by the ftyp box, which starts at offset 4', () => {
    // The first four bytes are the box SIZE, not magic. Looking at offset 0
    // is the obvious mistake and it rejects every valid mp4.
    expect(sniffVideo(mp4())).toBe('mp4');
    expect(sniffVideo(mp4('mp42'))).toBe('mp4');
  });

  it('recognises WebM and MKV by the EBML magic number', () => {
    expect(sniffVideo(webm())).toBe('webm');
  });

  it('refuses what a browser cannot play, however it is named', () => {
    // A RIFF/AVI header: a real video file, and a black rectangle in <video>.
    const avi = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00]);
    expect(sniffVideo(avi)).toBeNull();
    // A PNG renamed to .mp4 — the case the declared type would wave through.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(sniffVideo(png)).toBeNull();
  });

  it('does not read past a short buffer', () => {
    expect(sniffVideo(new Uint8Array([0x00, 0x00]))).toBeNull();
    expect(sniffVideo(new Uint8Array([]))).toBeNull();
  });
});

describe('checkVideo', () => {
  it('accepts a real video inside the cap', () => {
    const result = checkVideo(mp4(), 500 * 1024 * 1024);
    expect(result).toEqual({ ok: true, kind: 'mp4', extension: 'mp4', contentType: 'video/mp4' });
  });

  it('refuses on SIZE before it even looks at the bytes', () => {
    // A presigned PUT cannot cap what is sent, so this figure is the one
    // measured from the bucket afterwards — the only one worth trusting.
    expect(checkVideo(mp4(), MAX_VIDEO_BYTES + 1)).toEqual({ ok: false, error: 'videoTooLarge' });
  });

  it('refuses an empty object', () => {
    // A PUT that failed halfway can leave a zero-length object behind.
    expect(checkVideo(new Uint8Array([]), 0)).toEqual({ ok: false, error: 'notAVideo' });
  });

  it('refuses a file that is not a video even at a sane size', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(checkVideo(png, 1024)).toEqual({ ok: false, error: 'notAVideo' });
  });
});

describe('resolveVideoUpdate', () => {
  it('keeps an uploaded video when the link box is empty', () => {
    // The box is empty for an R2 lesson BY DESIGN — the key lives in the row,
    // not in the form — so reading the empty box as "no video" is what deleted
    // every upload the moment the lesson was saved.
    const current = { provider: 'r2' as const, id: 'lessons/abc/def.mp4' };
    expect(resolveVideoUpdate(current, '')).toEqual(current);
    expect(resolveVideoUpdate(current, '   ')).toEqual(current);
  });

  it('clears a pasted link when the box is emptied', () => {
    expect(resolveVideoUpdate({ provider: 'youtube', id: 'dQw4w9WgXcQ' }, '')).toEqual({
      provider: 'none',
      id: null,
    });
  });

  it('replaces an upload with a pasted link', () => {
    expect(
      resolveVideoUpdate({ provider: 'r2', id: 'lessons/abc/def.mp4' }, 'https://youtu.be/dQw4w9WgXcQ'),
    ).toEqual({ provider: 'youtube', id: 'dQw4w9WgXcQ' });
  });

  it('refuses a link it does not understand rather than storing a guess', () => {
    expect(resolveVideoUpdate({ provider: 'r2', id: 'key' }, 'https://vimeo.com/12345')).toBeNull();
  });

  it('parses a full Drive link back to its id', () => {
    expect(
      resolveVideoUpdate(
        { provider: 'none', id: null },
        'https://drive.google.com/file/d/1AbCdefGhIjKlMnOpQrStUvWxYz123456/view',
      ),
    ).toEqual({ provider: 'drive', id: '1AbCdefGhIjKlMnOpQrStUvWxYz123456' });
  });
});

describe('formatBytes', () => {
  it('reads as megabytes below a gigabyte and gigabytes above', () => {
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 Mo');
    expect(formatBytes(250 * 1024 * 1024)).toBe('250 Mo');
    expect(formatBytes(1.5 * 1024 * 1024 * 1024)).toBe('1.50 Go');
  });

  it('says 0 rather than NaN for a lesson with no upload', () => {
    expect(formatBytes(0)).toBe('0 Mo');
    expect(formatBytes(Number.NaN)).toBe('0 Mo');
  });
});
