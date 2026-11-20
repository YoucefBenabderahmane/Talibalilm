/**
 * Making a browser recording skippable, in the teacher's browser, before it is
 * uploaded.
 *
 * The class recorder (`lib/live/recording/session.ts`) saves what Chrome's
 * MediaRecorder hands it, and Chrome writes that WebM as a stream: it never
 * goes back to the start of the file, so the file carries neither its duration
 * nor an index of where each moment begins (Matroska "Cues"). Played from the
 * bucket, the player then shows no total time and its progress bar does not
 * move — a teacher could only watch a lesson from the beginning. Every
 * in-browser recorder writes the same kind of file.
 *
 * So the index is written here: her Chrome reads the file once, notes where
 * each cluster (a few seconds of picture and sound) starts and when, and builds
 * a new head for the file — SeekHead, Info with the Duration, Tracks, Cues. The
 * clusters themselves are kept byte for byte: the new file is the new head
 * followed by a `slice` of the original, so nothing is re-encoded and nothing
 * is copied in memory, whatever the size. The same idea as the PDFs: the work
 * happens on her machine, and only the result travels.
 *
 * Anything this code does not recognise is left exactly as it was
 * (`not-understood`), and the upload goes ahead as it always did. Indexing may
 * only ever make a file better.
 */

export type SeekableStatus = 'repaired' | 'already-seekable' | 'not-understood';

export interface SeekableVideo {
  /** What to upload: the indexed file, or the original one untouched. */
  blob: Blob;
  status: SeekableStatus;
  /** Why the file was left as it was (`not-understood` only), in the parser's words. */
  detail?: string;
  /** The duration written into the file, in milliseconds (`repaired` only). */
  durationMs?: number;
  /** How many places the index lets the player jump to (`repaired` only). */
  cues?: number;
}

export interface SeekableOptions {
  /** Bytes read so far, out of the file's size. Called once per read. */
  onProgress?: (read: number, total: number) => void;
  /** Aborting rejects with the signal's reason (an `AbortError`). */
  signal?: AbortSignal;
  /** How much is read at a time. Small values exist for the tests. */
  chunkBytes?: number;
}

/** 16 MB at a time: a two-hour recording is read in about a hundred steps. */
const CHUNK_BYTES = 16 * 1024 * 1024;

/** The Matroska elements this file reads or writes. */
const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Seek: 0x4dbb,
  SeekID: 0x53ab,
  SeekPosition: 0x53ac,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  ReferenceBlock: 0xfb,
  Cues: 0x1c53bb6b,
  CuePoint: 0xbb,
  CueTime: 0xb3,
  CueTrackPositions: 0xb7,
  CueTrack: 0xf7,
  CueClusterPosition: 0xf1,
  Tags: 0x1254c367,
  Chapters: 0x1043a770,
  Attachments: 0x1941a469,
  Void: 0xec,
  CRC32: 0xbf,
} as const;

/** What can follow a cluster at the top of the file, and so closes a streamed one. */
const TOP_LEVEL = new Set<number>([
  ID.SeekHead,
  ID.Info,
  ID.Tracks,
  ID.Cluster,
  ID.Cues,
  ID.Tags,
  ID.Chapters,
  ID.Attachments,
]);

/** The file is not laid out the way this code expects: leave it as it is. */
class NotUnderstood extends Error {}

const hex = (id: number) => `0x${id.toString(16).toUpperCase()}`;

/** An element's header, read from the file. */
interface Head {
  id: number;
  start: number;
  dataStart: number;
  /** `dataStart + size`, or Infinity for an element of unknown size (a stream). */
  end: number;
  unknown: boolean;
}

/**
 * A window on the file. Only the window is in memory; the parser moves it
 * forward as it goes, and never needs the bytes of a frame, only its header.
 */
class FileWindow {
  private start = 0;
  private bytes = new Uint8Array(0);

  constructor(
    private readonly file: Blob,
    private readonly chunk: number,
    private readonly options: SeekableOptions = {},
  ) {}

  get size() {
    return this.file.size;
  }

  /** True when `want` bytes from `at` (or up to the end of the file) are in memory. */
  has(at: number, want: number): boolean {
    const end = Math.min(this.file.size, at + want);
    return at >= this.start && end <= this.start + this.bytes.length;
  }

  async load(at: number, want: number): Promise<void> {
    const signal = this.options.signal;
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    const end = Math.min(this.file.size, at + Math.max(want, this.chunk));
    this.bytes = new Uint8Array(await this.file.slice(at, end).arrayBuffer());
    this.start = at;
    this.options.onProgress?.(end, this.file.size);
  }

  /** The header at `at` — already in memory. Null when the file ends inside it. */
  headIn(at: number): Head | null {
    const bytes = this.bytes;
    const limit = Math.min(this.bytes.length, this.file.size - this.start);
    let p = at - this.start;
    if (p >= limit) return null;

    const first = bytes[p]!;
    const idLength = first >= 0x80 ? 1 : first >= 0x40 ? 2 : first >= 0x20 ? 3 : first >= 0x10 ? 4 : 0;
    if (idLength === 0) throw new NotUnderstood(`no element at byte ${at}`);
    if (p + idLength > limit) return null;
    let id = 0;
    for (let i = 0; i < idLength; i++) id = id * 256 + bytes[p + i]!;
    p += idLength;

    if (p >= limit) return null;
    const lead = bytes[p]!;
    if (lead === 0) throw new NotUnderstood(`a size longer than 8 bytes at byte ${at}`);
    let sizeLength = 1;
    while (!(lead & (0x80 >> (sizeLength - 1)))) sizeLength++;
    if (p + sizeLength > limit) return null;
    let size = lead & (0xff >> sizeLength);
    let unknown = size === 0xff >> sizeLength;
    for (let i = 1; i < sizeLength; i++) {
      const b = bytes[p + i]!;
      size = size * 256 + b;
      if (b !== 0xff) unknown = false;
    }
    if (!unknown && !Number.isSafeInteger(size)) {
      throw new NotUnderstood(`an element too large at byte ${at}`);
    }
    const dataStart = at + idLength + sizeLength;
    return { id, start: at, dataStart, end: unknown ? Infinity : dataStart + size, unknown };
  }

  /** The header at `at`, reading the file if needed. */
  async head(at: number): Promise<Head | null> {
    if (!this.has(at, 12)) await this.load(at, 12);
    return this.headIn(at);
  }

  /** A copy of `[from, to)`. */
  async copy(from: number, to: number): Promise<Uint8Array> {
    if (!this.has(from, to - from)) await this.load(from, to - from);
    return this.bytes.slice(from - this.start, to - this.start);
  }

  /** `[from, from + length)`, read in place: valid until the window moves. */
  view(from: number, length: number): Uint8Array {
    return this.bytes.subarray(from - this.start, from - this.start + length);
  }
}

/** The children of an element already in memory, each checked to fit inside it. */
function* children(bytes: Uint8Array, from = 0, to = bytes.length) {
  let p = from;
  while (p < to) {
    const first = bytes[p]!;
    const idLength = first >= 0x80 ? 1 : first >= 0x40 ? 2 : first >= 0x20 ? 3 : first >= 0x10 ? 4 : 0;
    if (idLength === 0 || p + idLength >= to) throw new NotUnderstood('a malformed header element');
    let id = 0;
    for (let i = 0; i < idLength; i++) id = id * 256 + bytes[p + i]!;
    const lead = bytes[p + idLength]!;
    if (lead === 0) throw new NotUnderstood('a malformed header element');
    let sizeLength = 1;
    while (!(lead & (0x80 >> (sizeLength - 1)))) sizeLength++;
    if (p + idLength + sizeLength > to) throw new NotUnderstood('a malformed header element');
    let size = lead & (0xff >> sizeLength);
    for (let i = 1; i < sizeLength; i++) size = size * 256 + bytes[p + idLength + i]!;
    const dataStart = p + idLength + sizeLength;
    if (dataStart + size > to) throw new NotUnderstood(`element ${hex(id)} runs past its parent`);
    yield { id, start: p, dataStart, end: dataStart + size };
    p = dataStart + size;
  }
}

function readUint(bytes: Uint8Array, from: number, to: number): number {
  let value = 0;
  for (let i = from; i < to; i++) value = value * 256 + bytes[i]!;
  return value;
}

/** The track number, timestamp and flags at the start of a (Simple)Block. */
function blockHeader(bytes: Uint8Array): { track: number; relative: number; flags: number } {
  const lead = bytes[0];
  if (lead === undefined || lead === 0) throw new NotUnderstood('a malformed block');
  let length = 1;
  while (!(lead & (0x80 >> (length - 1)))) length++;
  if (bytes.length < length + 3) throw new NotUnderstood('a block too short');
  const track = readUint(bytes, 0, length) - (0x80 >> (length - 1)) * 256 ** (length - 1);
  const relative = ((bytes[length]! << 8) | bytes[length + 1]!) << 16 >> 16;
  return { track, relative, flags: bytes[length + 2]! };
}

/**
 * Read the head of the file, up to the first cluster: the EBML header, Info
 * (its children kept, minus any Duration, CRC-32 or Void), Tracks (which track
 * to index), any other element before the clusters (tags, chapters…), and
 * whether a Duration and an index are already there.
 */
async function readHead(win: FileWindow) {
  const ebml = await win.head(0);
  if (!ebml || ebml.id !== ID.EBML || ebml.unknown || ebml.end > win.size) {
    throw new NotUnderstood('not a WebM/Matroska file');
  }
  const segment = await win.head(ebml.end);
  if (!segment || segment.id !== ID.Segment) throw new NotUnderstood('no Segment after the EBML header');
  const segmentEnd = Math.min(win.size, segment.end);

  let infoKept: Uint8Array[] | null = null;
  let tracks: Uint8Array | null = null;
  let timecodeScale = 1_000_000;
  let hasDuration = false;
  let cueTrack = -1;
  let cuesAt: number | null = null;
  let hasCues = false;
  const kept: Uint8Array[] = [];

  let at = segment.dataStart;
  for (;;) {
    if (at >= segmentEnd) throw new NotUnderstood('no cluster in the file');
    const head = await win.head(at);
    if (!head) throw new NotUnderstood('the file ends before its first cluster');
    if (head.id === ID.Cluster) break;
    if (head.unknown) throw new NotUnderstood(`${hex(head.id)} of unknown size before the clusters`);
    if (head.end > segmentEnd) throw new NotUnderstood(`${hex(head.id)} runs past the end of the file`);

    if (head.id === ID.Info) {
      const bytes = await win.copy(head.dataStart, head.end);
      infoKept = [];
      for (const child of children(bytes)) {
        if (child.id === ID.TimecodeScale) timecodeScale = readUint(bytes, child.dataStart, child.end);
        if (child.id === ID.Duration) hasDuration = true;
        if (child.id === ID.Duration || child.id === ID.CRC32 || child.id === ID.Void) continue;
        infoKept.push(bytes.slice(child.start, child.end));
      }
    } else if (head.id === ID.Tracks) {
      tracks = await win.copy(head.start, head.end);
      const entries: { number: number; type: number }[] = [];
      const body = tracks.subarray(head.dataStart - head.start);
      for (const entry of children(body)) {
        if (entry.id !== ID.TrackEntry) continue;
        let number = -1;
        let type = -1;
        for (const field of children(body, entry.dataStart, entry.end)) {
          if (field.id === ID.TrackNumber) number = readUint(body, field.dataStart, field.end);
          if (field.id === ID.TrackType) type = readUint(body, field.dataStart, field.end);
        }
        entries.push({ number, type });
      }
      // The index follows the picture: a jump must land on a key frame. A
      // file with only sound is indexed on its sound.
      const pick = entries.find((e) => e.type === 1) ?? entries.find((e) => e.type === 2) ?? entries[0];
      cueTrack = pick?.number ?? -1;
    } else if (head.id === ID.SeekHead) {
      const bytes = await win.copy(head.dataStart, head.end);
      for (const seek of children(bytes)) {
        if (seek.id !== ID.Seek) continue;
        let target = -1;
        let position = -1;
        for (const field of children(bytes, seek.dataStart, seek.end)) {
          if (field.id === ID.SeekID) target = readUint(bytes, field.dataStart, field.end);
          if (field.id === ID.SeekPosition) position = readUint(bytes, field.dataStart, field.end);
        }
        if (target === ID.Cues && position >= 0) cuesAt = segment.dataStart + position;
      }
    } else if (head.id === ID.Cues) {
      hasCues = true;
    } else if (head.id === ID.EBML || head.id === ID.Segment) {
      throw new NotUnderstood('a second file inside this one');
    } else if (head.id !== ID.Void && head.id !== ID.CRC32) {
      kept.push(await win.copy(head.start, head.end));
    }
    at = head.end;
  }

  if (!infoKept) throw new NotUnderstood('no Info element');
  if (!tracks || cueTrack < 0) throw new NotUnderstood('no Tracks element');

  // An index at the end, announced at the start (what ffmpeg and OBS write).
  if (!hasCues && cuesAt !== null && cuesAt < segmentEnd) {
    const head = await win.head(cuesAt);
    hasCues = head?.id === ID.Cues;
  }

  return {
    ebml: await win.copy(0, ebml.end),
    infoKept,
    tracks,
    kept,
    timecodeScale,
    hasDuration,
    hasCues,
    cueTrack,
    segmentEnd,
    firstCluster: at,
  };
}

/** Walk every cluster: where it starts, when, and where its first key frame is. */
async function readClusters(win: FileWindow, head: Awaited<ReturnType<typeof readHead>>) {
  const { segmentEnd, cueTrack, firstCluster } = head;
  const cues: { time: number; cluster: number }[] = [];
  const tracks = new Map<number, { last: number; step: number }>();
  let bodyEnd = firstCluster;
  let streamed = false;

  const note = (track: number, time: number, key: boolean, cluster: number, cued: boolean) => {
    const seen = tracks.get(track);
    if (!seen) tracks.set(track, { last: time, step: 0 });
    else if (time > seen.last) {
      seen.step = time - seen.last;
      seen.last = time;
    }
    if (key && track === cueTrack && !cued) {
      cues.push({ time: Math.max(0, time), cluster });
      return true;
    }
    return cued;
  };

  let at = firstCluster;
  scan: while (at < segmentEnd) {
    if (!win.has(at, 12)) await win.load(at, 12);
    const element = win.headIn(at);
    if (!element) break; // the file ends inside a header

    if (element.id !== ID.Cluster) {
      // After the clusters: tags and padding travel with the body. Anything
      // that would need re-pointing after the shift is not ours to touch.
      if (element.unknown) throw new NotUnderstood(`${hex(element.id)} of unknown size after the clusters`);
      if (element.end > segmentEnd) break;
      if (element.id === ID.Cues) throw new NotUnderstood('an index at the end, not announced at the start');
      if (element.id === ID.Info || element.id === ID.Tracks || element.id === ID.SeekHead) {
        throw new NotUnderstood(`${hex(element.id)} after the clusters`);
      }
      if (element.id === ID.EBML || element.id === ID.Segment) {
        throw new NotUnderstood('a second file inside this one');
      }
      if (!TOP_LEVEL.has(element.id) && element.id !== ID.Void && element.id !== ID.CRC32) {
        throw new NotUnderstood(`unexpected ${hex(element.id)} at byte ${at}`);
      }
      at = element.end;
      bodyEnd = at;
      continue;
    }

    // A cluster of known size that the file cuts short is dropped whole.
    if (!element.unknown && element.end > segmentEnd) break;
    if (element.unknown) streamed = true;
    const limit = element.unknown ? segmentEnd : element.end;
    const cluster = element.start;
    let time = 0;
    let cued = false;
    let p = element.dataStart;

    while (p < limit) {
      if (!win.has(p, 12)) await win.load(p, 12);
      const child = win.headIn(p);
      if (!child) break scan; // cut off: the body ends at the last whole element
      if (element.unknown && TOP_LEVEL.has(child.id)) break; // a streamed cluster ends here
      if (child.id === ID.EBML || child.id === ID.Segment) {
        throw new NotUnderstood('a second file inside this one');
      }
      if (child.unknown) throw new NotUnderstood(`${hex(child.id)} of unknown size inside a cluster`);
      if (child.end > limit) {
        if (element.unknown) break scan; // a recording cut off mid-frame
        throw new NotUnderstood(`${hex(child.id)} runs past its cluster at byte ${p}`);
      }

      if (child.id === ID.Timecode) {
        if (!win.has(child.dataStart, child.end - child.dataStart)) {
          await win.load(child.dataStart, child.end - child.dataStart);
        }
        time = readUint(win.view(child.dataStart, child.end - child.dataStart), 0, child.end - child.dataStart);
      } else if (child.id === ID.SimpleBlock) {
        const length = Math.min(11, child.end - child.dataStart);
        if (!win.has(child.dataStart, length)) await win.load(child.dataStart, length);
        const block = blockHeader(win.view(child.dataStart, length));
        cued = note(block.track, time + block.relative, (block.flags & 0x80) !== 0, cluster, cued);
      } else if (child.id === ID.BlockGroup) {
        // A group is a key frame unless it names a frame it depends on.
        let block: ReturnType<typeof blockHeader> | null = null;
        let referenced = false;
        let q = child.dataStart;
        while (q < child.end) {
          if (!win.has(q, 12)) await win.load(q, 12);
          const part = win.headIn(q);
          if (!part || part.unknown || part.end > child.end) {
            throw new NotUnderstood(`a malformed block group at byte ${q}`);
          }
          if (part.id === ID.Block) {
            const length = Math.min(11, part.end - part.dataStart);
            if (!win.has(part.dataStart, length)) await win.load(part.dataStart, length);
            block = blockHeader(win.view(part.dataStart, length));
          } else if (part.id === ID.ReferenceBlock) {
            referenced = true;
          }
          q = part.end;
        }
        if (block) cued = note(block.track, time + block.relative, !referenced, cluster, cued);
      }
      p = child.end;
      if (element.unknown) bodyEnd = p;
    }
    if (!element.unknown) bodyEnd = element.end;
    at = element.unknown ? p : element.end;
  }

  if (tracks.size === 0) throw new NotUnderstood('no frames in the file');

  // The duration is the end of the last frame: its time, plus the gap the
  // frames before it kept (capped at a second, for a track that went quiet).
  const second = 1e9 / head.timecodeScale;
  let duration = 0;
  for (const { last, step } of tracks.values()) {
    duration = Math.max(duration, last + Math.min(step, second));
  }
  return { cues, bodyEnd, duration, streamed };
}

// --- Writing ---------------------------------------------------------------

function idBytes(id: number): Uint8Array {
  const length = id < 0x100 ? 1 : id < 0x10000 ? 2 : id < 0x1000000 ? 3 : 4;
  return bigEndian(id, length);
}

function bigEndian(value: number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let v = value;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  return out;
}

/** The shortest size field for `value` (all-ones is reserved for "unknown"). */
function sizeField(value: number): Uint8Array {
  for (let length = 1; length <= 8; length++) {
    if (value < 2 ** (7 * length) - 1) {
      const out = bigEndian(value, length);
      out[0]! |= 0x80 >> (length - 1);
      return out;
    }
  }
  throw new RangeError(`no size field for ${value}`);
}

/** "Size unknown", on 8 bytes: how a recorder that streams writes its Segment. */
const UNKNOWN_SIZE_8 = new Uint8Array([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);

/** An 8-byte size field, so the Segment's header has a fixed length. */
function sizeField8(value: number): Uint8Array {
  const out = bigEndian(value, 8);
  out[0]! |= 0x01;
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let p = 0;
  for (const part of parts) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}

function element(id: number, ...content: Uint8Array[]): Uint8Array {
  const body = concat(content);
  return concat([idBytes(id), sizeField(body.length), body]);
}

/** Unsigned integers as 8 bytes: an offset's length never depends on its value. */
const uint8Bytes = (value: number) => bigEndian(value, 8);

function float64(value: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setFloat64(0, value);
  return out;
}

function minimalUint(value: number): Uint8Array {
  let length = 1;
  while (value >= 256 ** length && length < 8) length++;
  return bigEndian(value, length);
}

/**
 * The new head. Every offset is written on 8 bytes, so each element's length
 * is known before any position is, and every position follows in one pass.
 */
function writeHead(head: Awaited<ReturnType<typeof readHead>>, clusters: Awaited<ReturnType<typeof readClusters>>) {
  const { firstCluster } = head;
  const { cues, bodyEnd, duration } = clusters;

  const info = element(ID.Info, ...head.infoKept, element(ID.Duration, float64(duration)));
  const kept = concat(head.kept);

  // One CuePoint, as a template whose two numbers are patched per cue.
  const cueContent = concat([
    element(ID.CueTime, uint8Bytes(0)),
    element(
      ID.CueTrackPositions,
      element(ID.CueTrack, minimalUint(head.cueTrack)),
      element(ID.CueClusterPosition, uint8Bytes(0)),
    ),
  ]);
  const template = concat([idBytes(ID.CuePoint), sizeField(cueContent.length), cueContent]);
  // CueTime comes first (1-byte ID, 1-byte size, then its value); the cluster
  // position is the last element, so its value is the template's last 8 bytes.
  const timeValueAt = template.length - cueContent.length + 2;
  const positionValueAt = template.length - 8;

  const cuesBody = cues.length * template.length;
  const cuesLength = cues.length ? idBytes(ID.Cues).length + sizeField(cuesBody).length + cuesBody : 0;

  const seekHead = (positions: [number, number][]) =>
    element(
      ID.SeekHead,
      ...positions.map(([target, position]) =>
        element(ID.Seek, element(ID.SeekID, idBytes(target)), element(ID.SeekPosition, uint8Bytes(position))),
      ),
    );
  const targets: number[] = cues.length ? [ID.Info, ID.Tracks, ID.Cues] : [ID.Info, ID.Tracks];
  const seekLength = seekHead(targets.map((t) => [t, 0])).length;

  // Positions count from the first byte inside the Segment.
  const infoAt = seekLength;
  const tracksAt = infoAt + info.length;
  const cuesAt = tracksAt + head.tracks.length + kept.length;
  const clustersAt = cuesAt + cuesLength;
  const positions: Record<number, number> = { [ID.Info]: infoAt, [ID.Tracks]: tracksAt, [ID.Cues]: cuesAt };

  const index = new Uint8Array(cuesLength);
  if (cues.length) {
    const header = concat([idBytes(ID.Cues), sizeField(cuesBody)]);
    index.set(header, 0);
    const view = new DataView(index.buffer);
    let p = header.length;
    for (const cue of cues) {
      index.set(template, p);
      view.setBigUint64(p + timeValueAt, BigInt(Math.round(cue.time)));
      view.setBigUint64(p + positionValueAt, BigInt(clustersAt + (cue.cluster - firstCluster)));
      p += template.length;
    }
  }

  // Clusters of unknown size (Chrome's) may only sit in a Segment of unknown
  // size: the Segment keeps the size Chrome gave it, since a jump is found
  // through the index, never through the Segment's length.
  const segmentSize = clustersAt + (bodyEnd - firstCluster);
  const bytes = concat([
    head.ebml,
    idBytes(ID.Segment),
    clusters.streamed ? UNKNOWN_SIZE_8 : sizeField8(segmentSize),
    seekHead(targets.map((t) => [t, positions[t]!])),
    info,
    head.tracks,
    kept,
    index,
  ]);
  // The Segment's ID and its 8-byte size: what the positions count from.
  return { bytes, segmentData: head.ebml.length + 4 + 8 };
}

/**
 * Read the new file back the way a player will: follow what its own SeekHead
 * and Cues SAY, as written, and check each place holds what it should. A slip
 * in the arithmetic above must cost the index, never the lesson.
 */
async function verify(blob: Blob, written: ReturnType<typeof writeHead>) {
  const { bytes, segmentData } = written;
  const win = new FileWindow(blob, 64 * 1024);
  const expect = async (at: number, id: number, what: string) => {
    const head = await win.head(at);
    if (head?.id !== id) throw new NotUnderstood(`self-check: no ${what} at byte ${at}`);
    return head;
  };

  const segment = await expect(segmentData - 12, ID.Segment, 'Segment');
  if (!segment.unknown && segment.end !== blob.size) {
    throw new NotUnderstood('self-check: the Segment size is wrong');
  }
  // The head ends where the clusters begin.
  await expect(bytes.length, ID.Cluster, 'first cluster');

  const top = [...children(bytes, segmentData)];
  const seekHead = top.find((e) => e.id === ID.SeekHead);
  if (!seekHead) throw new NotUnderstood('self-check: no SeekHead');
  for (const seek of children(bytes, seekHead.dataStart, seekHead.end)) {
    const fields = [...children(bytes, seek.dataStart, seek.end)];
    const target = fields.find((f) => f.id === ID.SeekID);
    const position = fields.find((f) => f.id === ID.SeekPosition);
    if (!target || !position) throw new NotUnderstood('self-check: a malformed Seek');
    const id = readUint(bytes, target.dataStart, target.end);
    await expect(segmentData + readUint(bytes, position.dataStart, position.end), id, hex(id));
  }

  const cues = top.find((e) => e.id === ID.Cues);
  if (!cues) return;
  const points = [...children(bytes, cues.dataStart, cues.end)];
  for (const point of [points[0], points[Math.floor(points.length / 2)], points[points.length - 1]]) {
    if (!point) continue;
    const track = [...children(bytes, point.dataStart, point.end)].find((e) => e.id === ID.CueTrackPositions);
    const cluster = track && [...children(bytes, track.dataStart, track.end)].find((e) => e.id === ID.CueClusterPosition);
    if (!cluster) throw new NotUnderstood('self-check: a malformed CuePoint');
    await expect(segmentData + readUint(bytes, cluster.dataStart, cluster.end), ID.Cluster, 'indexed cluster');
  }
}

/**
 * Give a WebM (or MKV) its duration and its index, so it can be skipped
 * through once uploaded. Resolves with the file to upload; rejects only when
 * `signal` aborts.
 */
export async function makeWebmSeekable(file: Blob, options: SeekableOptions = {}): Promise<SeekableVideo> {
  const win = new FileWindow(file, options.chunkBytes ?? CHUNK_BYTES, options);
  try {
    const head = await readHead(win);
    if (head.hasDuration && head.hasCues) {
      options.onProgress?.(file.size, file.size);
      return { blob: file, status: 'already-seekable' };
    }
    if (head.hasCues) throw new NotUnderstood('an index without a duration');

    const clusters = await readClusters(win, head);
    if (clusters.bodyEnd <= head.firstCluster) throw new NotUnderstood('no whole cluster in the file');
    const written = writeHead(head, clusters);
    const blob = new Blob([written.bytes, file.slice(head.firstCluster, clusters.bodyEnd)], {
      type: file.type || 'video/webm',
    });
    await verify(blob, written);
    options.onProgress?.(file.size, file.size);
    return {
      blob,
      status: 'repaired',
      durationMs: Math.round((clusters.duration * head.timecodeScale) / 1e6),
      cues: clusters.cues.length,
    };
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason ?? error;
    const detail =
      error instanceof NotUnderstood
        ? error.message
        : error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error);
    return { blob: file, status: 'not-understood', detail };
  }
}
