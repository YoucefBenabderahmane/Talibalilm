import { describe, expect, it } from 'vitest';
import { makeWebmSeekable } from '@/lib/media/webm-seek';

/**
 * The files here are built byte by byte the way Chrome's MediaRecorder writes
 * them — a Segment and Clusters of unknown size, no Duration, no Cues, sound in
 * SimpleBlocks and picture in BlockGroups whose key frames carry no
 * ReferenceBlock — and the result is read back with a parser written for the
 * test, independent of the one under test.
 */

// --- Writing EBML ----------------------------------------------------------

type Bytes = number[];

function idBytes(id: number): Bytes {
  const out: Bytes = [];
  for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v % 256);
  return out;
}

function sizeBytes(size: number): Bytes {
  let length = 1;
  while (size >= 2 ** (7 * length) - 1) length++;
  const out: Bytes = [];
  for (let i = 0, v = size; i < length; i++, v = Math.floor(v / 256)) out.unshift(v % 256);
  out[0]! |= 0x80 >> (length - 1);
  return out;
}

const UNKNOWN: Bytes = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
const el = (id: number, ...content: Bytes[]): Bytes => {
  const body = content.flat();
  return [...idBytes(id), ...sizeBytes(body.length), ...body];
};
const streamed = (id: number, ...content: Bytes[]): Bytes => [...idBytes(id), ...UNKNOWN, ...content.flat()];
const uint = (value: number): Bytes => {
  const out: Bytes = [];
  for (let v = value; v > 0 || out.length === 0; v = Math.floor(v / 256)) out.unshift(v % 256);
  return out;
};
const text = (s: string): Bytes => [...s].map((c) => c.charCodeAt(0));
const payload = (length: number, seed: number): Bytes =>
  Array.from({ length }, (_, i) => (i * 31 + seed * 7) % 251);

const EBML_HEADER = el(
  0x1a45dfa3,
  el(0x4286, uint(1)),
  el(0x42f7, uint(1)),
  el(0x42f2, uint(4)),
  el(0x42f3, uint(8)),
  el(0x4282, text('webm')),
  el(0x4287, uint(4)),
  el(0x4285, uint(2)),
);
const INFO = el(0x1549a966, el(0x2ad7b1, uint(1_000_000)), el(0x4d80, text('Chrome')), el(0x5741, text('Chrome')));
const AUDIO = 1;
const VIDEO = 2;
const TRACKS = el(
  0x1654ae6b,
  el(0xae, el(0xd7, uint(AUDIO)), el(0x83, uint(2)), el(0x86, text('A_OPUS'))),
  el(0xae, el(0xd7, uint(VIDEO)), el(0x83, uint(1)), el(0x86, text('V_VP9'))),
);
const AUDIO_ONLY_TRACKS = el(0x1654ae6b, el(0xae, el(0xd7, uint(AUDIO)), el(0x83, uint(2))));

const sound = (relative: number, seed: number): Bytes =>
  el(0xa3, [0x80 | AUDIO, (relative >> 8) & 0xff, relative & 0xff, 0x80], payload(40, seed));
const picture = (relative: number, key: boolean, seed: number): Bytes =>
  el(
    0xa0,
    el(0xa1, [0x80 | VIDEO, (relative >> 8) & 0xff, relative & 0xff, 0x00], payload(120, seed)),
    key ? [] : el(0xfb, [0xff]),
  );

interface Recording {
  clusters?: number;
  /** Clusters whose first picture is not a key frame (Chrome cuts at its 5 s chunks too). */
  withoutKey?: number[];
  knownSizes?: boolean;
  audioOnly?: boolean;
}

/** A recording, one second per cluster, picture every 100 ms and sound every 60 ms. */
function recording({ clusters = 4, withoutKey = [], knownSizes = false, audioOnly = false }: Recording = {}) {
  const parts: Bytes[] = [];
  for (let c = 0; c < clusters; c++) {
    const blocks: Bytes[] = [el(0xe7, uint(c * 1000))];
    for (let t = 0; t < 1000; t += 20) {
      if (t % 60 === 0) blocks.push(sound(t, c * 100 + t));
      if (!audioOnly && t % 100 === 0) {
        blocks.push(picture(t + 2, t === 0 && !withoutKey.includes(c), c * 100 + t));
      }
    }
    parts.push(knownSizes ? el(0x1f43b675, ...blocks) : streamed(0x1f43b675, ...blocks));
  }
  const head = [...EBML_HEADER, 0x18, 0x53, 0x80, 0x67, ...UNKNOWN, ...INFO, ...(audioOnly ? AUDIO_ONLY_TRACKS : TRACKS)];
  return { head: Uint8Array.from(head), clusters: Uint8Array.from(parts.flat()) };
}

const blobOf = (...parts: Uint8Array[]) => new Blob(parts as BlobPart[], { type: 'video/webm' });
const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());

// --- Reading EBML back -----------------------------------------------------

interface Element {
  id: number;
  start: number;
  dataStart: number;
  end: number;
  unknown: boolean;
}

function readElement(bytes: Uint8Array, at: number): Element {
  const first = bytes[at]!;
  const idLength = first >= 0x80 ? 1 : first >= 0x40 ? 2 : first >= 0x20 ? 3 : 4;
  let id = 0;
  for (let i = 0; i < idLength; i++) id = id * 256 + bytes[at + i]!;
  const lead = bytes[at + idLength]!;
  let sizeLength = 1;
  while (!(lead & (0x80 >> (sizeLength - 1)))) sizeLength++;
  let size = lead & (0xff >> sizeLength);
  let unknown = size === 0xff >> sizeLength;
  for (let i = 1; i < sizeLength; i++) {
    size = size * 256 + bytes[at + idLength + i]!;
    if (bytes[at + idLength + i] !== 0xff) unknown = false;
  }
  const dataStart = at + idLength + sizeLength;
  return { id, start: at, dataStart, end: unknown ? bytes.length : dataStart + size, unknown };
}

const TOP = new Set([0x114d9b74, 0x1549a966, 0x1654ae6b, 0x1f43b675, 0x1c53bb6b, 0x1254c367]);

/** The elements in [from, to), a streamed Cluster ending at the next top-level element. */
function walk(bytes: Uint8Array, from: number, to: number): Element[] {
  const out: Element[] = [];
  let at = from;
  while (at < to) {
    const element = readElement(bytes, at);
    if (element.unknown && element.id === 0x1f43b675) {
      let p = element.dataStart;
      while (p < to) {
        const child = readElement(bytes, p);
        if (TOP.has(child.id)) break;
        p = child.end;
      }
      element.end = p;
    }
    out.push(element);
    at = element.end;
  }
  if (at !== to) throw new Error(`walk overran: ${at} vs ${to}`);
  return out;
}

const uintAt = (bytes: Uint8Array, e: Element) => {
  let v = 0;
  for (let i = e.dataStart; i < e.end; i++) v = v * 256 + bytes[i]!;
  return v;
};

/** Everything a player reads from the head of the file. */
function readSeekable(bytes: Uint8Array) {
  const [ebml, segment] = walk(bytes, 0, bytes.length).slice(0, 2) as [Element, Element];
  const top = walk(bytes, segment.dataStart, bytes.length);
  const find = (id: number) => top.find((e) => e.id === id);
  const info = walk(bytes, find(0x1549a966)!.dataStart, find(0x1549a966)!.end);
  const durationElement = info.find((e) => e.id === 0x4489);
  const seeks = walk(bytes, find(0x114d9b74)!.dataStart, find(0x114d9b74)!.end).map((seek) => {
    const [target, position] = walk(bytes, seek.dataStart, seek.end);
    return { target: uintAt(bytes, target!), position: uintAt(bytes, position!) };
  });
  const cuesElement = find(0x1c53bb6b);
  const cues = cuesElement
    ? walk(bytes, cuesElement.dataStart, cuesElement.end).map((point) => {
        const [time, positions] = walk(bytes, point.dataStart, point.end);
        const [track, cluster] = walk(bytes, positions!.dataStart, positions!.end);
        return { time: uintAt(bytes, time!), track: uintAt(bytes, track!), cluster: uintAt(bytes, cluster!) };
      })
    : [];
  return {
    ebml,
    segment,
    top,
    duration: durationElement
      ? new DataView(bytes.buffer, bytes.byteOffset + durationElement.dataStart, 8).getFloat64(0)
      : null,
    seeks,
    cues,
    clustersAt: top.find((e) => e.id === 0x1f43b675)!.start,
  };
}

// --- The tests -------------------------------------------------------------

describe('makeWebmSeekable', () => {
  it('gives a recording made by Chrome its duration and its index', async () => {
    const { head, clusters } = recording({ clusters: 4 });
    const input = blobOf(head, clusters);
    const result = await makeWebmSeekable(input);

    expect(result.status).toBe('repaired');
    const out = await bytesOf(result.blob);
    const file = readSeekable(out);

    // The EBML header is the original's, byte for byte.
    expect(out.subarray(0, file.ebml.end)).toEqual(head.subarray(0, file.ebml.end));
    // Chrome's clusters have no size, so the Segment keeps "unknown" as well.
    expect(file.segment.unknown).toBe(true);

    // The last frame starts at 3.960 s (sound every 60 ms): the file ends one
    // step later.
    expect(file.duration).toBe(4020);
    expect(result.durationMs).toBe(4020);

    // The SeekHead names Info, Tracks and Cues where they really are.
    const segmentData = file.segment.dataStart;
    expect(file.seeks.map((s) => s.target)).toEqual([0x1549a966, 0x1654ae6b, 0x1c53bb6b]);
    for (const seek of file.seeks) {
      expect(readElement(out, segmentData + seek.position).id).toBe(seek.target);
    }

    // One cue per cluster, on the picture's key frame, pointing at a Cluster
    // whose own time is the cue's.
    expect(file.cues.map((c) => c.time)).toEqual([2, 1002, 2002, 3002]);
    expect(new Set(file.cues.map((c) => c.track))).toEqual(new Set([VIDEO]));
    for (const cue of file.cues) {
      const cluster = readElement(out, segmentData + cue.cluster);
      expect(cluster.id).toBe(0x1f43b675);
      const timecode = readElement(out, cluster.dataStart);
      expect(timecode.id).toBe(0xe7);
      expect(uintAt(out, timecode)).toBe(cue.time - 2);
    }
    expect(result.cues).toBe(4);

    // Every picture and every sound, byte for byte.
    expect(out.subarray(file.clustersAt)).toEqual(clusters);
  });

  it('reads the file the same way whatever the size of each read', async () => {
    const { head, clusters } = recording({ clusters: 3 });
    const whole = await bytesOf((await makeWebmSeekable(blobOf(head, clusters))).blob);
    for (const chunkBytes of [7, 64, 1000]) {
      const result = await makeWebmSeekable(blobOf(head, clusters), { chunkBytes });
      expect(result.status).toBe('repaired');
      expect(await bytesOf(result.blob)).toEqual(whole);
    }
  });

  it('indexes only the clusters a jump can start from: those holding a key frame', async () => {
    const { head, clusters } = recording({ clusters: 4, withoutKey: [1, 2] });
    const result = await makeWebmSeekable(blobOf(head, clusters));
    const file = readSeekable(await bytesOf(result.blob));
    expect(file.cues.map((c) => c.time)).toEqual([2, 3002]);
  });

  it('keeps a recording cut off mid-frame, up to its last whole frame', async () => {
    // What the disk copy holds after a crash: the last chunk stops anywhere.
    const { head, clusters } = recording({ clusters: 3 });
    const cut = clusters.subarray(0, clusters.length - 50);
    const result = await makeWebmSeekable(blobOf(head, cut));

    expect(result.status).toBe('repaired');
    const out = await bytesOf(result.blob);
    const file = readSeekable(out);
    const body = out.subarray(file.clustersAt);
    // A prefix of what was there, ending on a whole element.
    expect(body).toEqual(cut.subarray(0, body.length));
    expect(body.length).toBeLessThan(cut.length);
    walk(out, file.clustersAt, out.length);
    expect(file.duration).toBeLessThan(3020);
  });

  it('handles clusters of known size, and then gives the Segment its size', async () => {
    // How ffmpeg and OBS write a Matroska file that was never finished.
    const { head, clusters } = recording({ clusters: 3, knownSizes: true });
    const result = await makeWebmSeekable(blobOf(head, clusters));

    expect(result.status).toBe('repaired');
    const out = await bytesOf(result.blob);
    const file = readSeekable(out);
    expect(file.segment.unknown).toBe(false);
    expect(file.segment.end).toBe(out.length);
    expect(file.cues).toHaveLength(3);
    expect(out.subarray(file.clustersAt)).toEqual(clusters);
  });

  it('indexes on the sound when there is no picture', async () => {
    const { head, clusters } = recording({ clusters: 3, audioOnly: true });
    const result = await makeWebmSeekable(blobOf(head, clusters));
    const file = readSeekable(await bytesOf(result.blob));
    expect(file.cues.map((c) => [c.time, c.track])).toEqual([
      [0, AUDIO],
      [1000, AUDIO],
      [2000, AUDIO],
    ]);
  });

  it('leaves a file that already has its duration and its index exactly as it was', async () => {
    const { head, clusters } = recording({ clusters: 2 });
    const once = (await makeWebmSeekable(blobOf(head, clusters))).blob;
    const again = await makeWebmSeekable(once);
    expect(again.status).toBe('already-seekable');
    expect(again.blob).toBe(once);
  });

  it('uploads anything it does not recognise exactly as it was, saying why', async () => {
    const { head, clusters } = recording({ clusters: 2 });
    const mp4 = blobOf(Uint8Array.from([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]));
    const secondFile = blobOf(head, clusters, Uint8Array.from(EBML_HEADER));
    const garbage = blobOf(head, Uint8Array.from([0x00, 0x00, 0x00, 0x00]), clusters);

    for (const input of [mp4, secondFile, garbage]) {
      const result = await makeWebmSeekable(input);
      expect(result.status).toBe('not-understood');
      expect(result.blob).toBe(input);
      expect(result.detail).toMatch(/\w/);
    }
  });

  it('reports how far it has read, and stops at « Annuler »', async () => {
    const { head, clusters } = recording({ clusters: 4 });
    const input = blobOf(head, clusters);
    const seen: number[] = [];
    await makeWebmSeekable(input, { chunkBytes: 256, onProgress: (read, total) => seen.push(read / total) });
    expect(seen.length).toBeGreaterThan(3);
    expect(seen.at(-1)).toBe(1);

    const cancel = new AbortController();
    cancel.abort();
    await expect(makeWebmSeekable(input, { signal: cancel.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});
