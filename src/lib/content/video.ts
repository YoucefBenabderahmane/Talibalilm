/**
 * Turn whatever the office pastes into a provider and an opaque id.
 *
 * The school's workflow is: record the live class with MeetPress, upload the
 * file to YouTube or Google Drive, paste the link here. So the field has to
 * accept a *link*, while the database stores only an **id** — the
 * `lesson_content_video_id_not_url` constraint rejects a URL outright, so that
 * a leaked row can never be a playable address.
 *
 * Parsing is also the security boundary. The id is interpolated into an iframe
 * `src`, so it is matched against a strict character class here and the URL is
 * built from a fixed template at render time. Nothing the office types can
 * become a different host, a `javascript:` URL, or extra query parameters.
 */
export type VideoProvider = 'youtube' | 'drive' | 'bunny' | 'r2' | 'none';

export interface VideoRef {
  provider: VideoProvider;
  id: string;
}

/** YouTube ids are exactly 11 chars of URL-safe base64. */
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
/** Drive file ids vary in length but share the same alphabet. */
const DRIVE_ID = /^[A-Za-z0-9_-]{10,100}$/;

const NONE: VideoRef = { provider: 'none', id: '' };

function youtubeFrom(url: URL): string | null {
  const host = url.hostname.replace(/^www\./, '');

  if (host === 'youtu.be') {
    return url.pathname.slice(1).split('/')[0] ?? null;
  }
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtube-nocookie.com') {
    // /watch?v=ID
    const v = url.searchParams.get('v');
    if (v) return v;
    // /embed/ID, /live/ID, /shorts/ID, /v/ID
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length >= 2 && ['embed', 'live', 'shorts', 'v'].includes(parts[0]!)) {
      return parts[1] ?? null;
    }
  }
  return null;
}

function driveFrom(url: URL): string | null {
  const host = url.hostname.replace(/^www\./, '');
  if (host !== 'drive.google.com') return null;

  // /file/d/ID/view, /file/d/ID/preview
  const parts = url.pathname.split('/').filter(Boolean);
  const d = parts.indexOf('d');
  if (d !== -1 && parts[d + 1]) return parts[d + 1]!;

  // /open?id=ID, /uc?id=ID
  return url.searchParams.get('id');
}

/**
 * Parse a pasted link, or accept an id that is already bare.
 *
 * Returns `none` for anything unrecognised rather than guessing — a wrong guess
 * would be stored and then rendered as a broken player, which is worse than
 * telling the office the link was not understood.
 */
export function parseVideoRef(input: string, fallback: VideoProvider = 'none'): VideoRef {
  const raw = input.trim();
  if (!raw) return NONE;

  if (/^https?:\/\//i.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return NONE;
    }

    const yt = youtubeFrom(url);
    if (yt && YOUTUBE_ID.test(yt)) return { provider: 'youtube', id: yt };

    const drive = driveFrom(url);
    if (drive && DRIVE_ID.test(drive)) return { provider: 'drive', id: drive };

    return NONE;
  }

  // Not a URL. An 11-char token is almost certainly a YouTube id; anything else
  // keeps whatever provider the lesson already had (a Bunny id, typically).
  if (YOUTUBE_ID.test(raw)) return { provider: 'youtube', id: raw };
  if (fallback !== 'none' && DRIVE_ID.test(raw)) return { provider: fallback, id: raw };
  return NONE;
}

/** The two `lesson_content` columns a video decision writes. */
export interface VideoColumns {
  provider: VideoProvider;
  /** Null when there is no video; the key for an uploaded one. */
  id: string | null;
}

/**
 * What the video columns become when the lesson form is saved.
 *
 * The link box is intentionally EMPTY for an uploaded video — the file lives
 * in the bucket and the box is not where its key belongs — so an empty box must
 * not be read as "no video". Reading it that way is what used to delete an
 * upload the moment the lesson was saved: `parseVideoRef('')` answers `none`,
 * and the upsert wrote `none` over the R2 row.
 *
 * A link, when present, replaces whatever was there. Returns null for a link
 * that is not understood, so the caller can say so rather than storing a guess.
 */
export function resolveVideoUpdate(current: VideoColumns, link: string): VideoColumns | null {
  if (link.trim() === '') {
    if (current.provider === 'r2' && current.id) return { provider: 'r2', id: current.id };
    return { provider: 'none', id: null };
  }

  const parsed = parseVideoRef(link);
  if (parsed.provider === 'none') return null;
  return { provider: parsed.provider, id: parsed.id };
}

/**
 * The embed address for a stored ref.
 *
 * Built from a fixed template, never from anything stored, and null for a
 * provider with no embed of its own. `youtube-nocookie` is deliberate: it stops
 * YouTube setting tracking cookies on a student who only came to watch a
 * lesson, which also keeps the cookie banner honest.
 */
export function embedUrl(ref: VideoRef): string | null {
  if (ref.provider === 'youtube' && YOUTUBE_ID.test(ref.id)) {
    return `https://www.youtube-nocookie.com/embed/${ref.id}?rel=0&modestbranding=1`;
  }
  if (ref.provider === 'drive' && DRIVE_ID.test(ref.id)) {
    return `https://drive.google.com/file/d/${ref.id}/preview`;
  }
  // 'r2' deliberately returns null. An uploaded video is not an embed: it is
  // played by a <video> element pointed at a signature that expires within the
  // hour, minted only after the RLS-gated read has already let the row through.
  // Building an address here would mean holding a playable URL in a pure
  // function that has no idea who is asking.
  return null;
}
