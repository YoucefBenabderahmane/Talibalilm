/**
 * Object keys for the bucket.
 *
 * Pure, and separated from the client that signs URLs, because the shape of a
 * key is a security rule rather than a storage detail: the database has a CHECK
 * constraint demanding exactly this pattern, so a key built here and a key the
 * table will accept cannot drift apart without a test failing.
 *
 * The name is random, not the uploader's filename. A filename arrives from a
 * browser and may contain anything at all — path separators, `..`, control
 * characters, a name that collides with someone else's slide. None of that can
 * reach the bucket if the bucket never sees it: the original is kept in a
 * column, for display only, and the object is filed under bytes we chose.
 */

/** Mirrors `live_slides_key_owned` in the migration. Keep the two in step. */
export const SLIDE_KEY_PATTERN = /^live\/[0-9a-f-]{36}\/[A-Za-z0-9_-]{8,64}\.(png|jpg|webp)$/;

/**
 * A page of a shared deck: `decks/<sha256 of the PDF>/<random>.<ext>`.
 *
 * Content-addressed, so the same PDF taught to a second class reuses these
 * objects instead of rendering and uploading them again. Mirrors the second
 * branch of `live_slides_key_owned`.
 */
export const DECK_KEY_PATTERN = /^decks\/[a-f0-9]{64}\/[A-Za-z0-9_-]{8,64}\.(png|jpg|webp)$/;

export type SlideExtension = 'png' | 'jpg' | 'webp';

/**
 * Where one slide lives: `live/<session id>/<random>.<ext>`.
 *
 * The session id is the prefix, which is what makes a cross-class read
 * impossible to construct rather than merely refused — there is no key naming
 * another class's object that this session's row would be allowed to hold.
 */
export function slideKey(sessionId: string, extension: SlideExtension, random: string): string {
  return `live/${sessionId}/${random}.${extension}`;
}

/** 16 URL-safe bytes of randomness, for the object's name. */
export function slideName(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Is this a key we issued for this session?
 *
 * Every action that takes a key from the browser runs it through here before
 * anything else, so a caller cannot reach sideways into another class's prefix
 * or escape the bucket layout by sending `..`. The database refuses the same
 * thing independently; this is the cheaper of the two refusals, not the only.
 */
export function isSlideKeyFor(key: string, sessionId: string): boolean {
  return SLIDE_KEY_PATTERN.test(key) && key.startsWith(`live/${sessionId}/`);
}

/** One page of a shared deck, under the PDF's own fingerprint. */
export function deckKey(fingerprint: string, extension: SlideExtension, random: string): string {
  return `decks/${fingerprint}/${random}.${extension}`;
}

/**
 * Is this a key shaped like a shared deck page?
 *
 * Staff-only path, and the fingerprint is not secret — the bytes are the same
 * for every class that uses the deck, and a session's `live_slides` row is
 * still what decides who may read it.
 */
export function isDeckKey(key: string): boolean {
  return DECK_KEY_PATTERN.test(key);
}

/** The filename kept for display: no path, no control characters, bounded. */
export function safeFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  return base
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 120);
}

/**
 * Where one lesson video lives: `lessons/<lesson id>/<random>.<ext>`.
 *
 * Same reasoning as a slide key, one level up: the lesson id is the prefix, so
 * a key naming another lesson's object is not something a caller can construct
 * and have accepted — it is refused by shape before R2 is ever called.
 *
 * The random name matters more here than for a slide. A predictable key would
 * let anyone who guessed a lesson id ask us to sign a URL for its video, and a
 * signed URL does not consult the paywall once it exists.
 */
export const VIDEO_KEY_PATTERN = /^lessons\/[0-9a-f-]{36}\/[A-Za-z0-9_-]{8,64}\.(mp4|webm)$/;

export type VideoExtension = 'mp4' | 'webm';

export function videoKey(lessonId: string, extension: VideoExtension, random: string): string {
  return `lessons/${lessonId}/${random}.${extension}`;
}

/** Is this a key we issued for this lesson? */
export function isVideoKeyFor(key: string, lessonId: string): boolean {
  return VIDEO_KEY_PATTERN.test(key) && key.startsWith(`lessons/${lessonId}/`);
}

/**
 * Where one lesson document lives: `lesson-docs/<lesson id>/<random>.pdf`.
 *
 * Deliberately its own prefix rather than a second extension under `lessons/`.
 * A document has a different reader (a card and a signed link, not a player), a
 * different size cap and a different lifetime from a recording, and a shared
 * prefix would blur all three the first time one of them changes.
 *
 * The lesson id is the prefix for the same reason as the video: a key naming
 * another lesson's file is refused by shape before R2 is ever called, and the
 * random name keeps a guessed lesson id from becoming a signed URL.
 */
export const DOCUMENT_KEY_PATTERN =
  /^lesson-docs\/[0-9a-f-]{36}\/[A-Za-z0-9_-]{8,64}\.pdf$/;

export function documentKey(lessonId: string, random: string): string {
  return `lesson-docs/${lessonId}/${random}.pdf`;
}

/** Is this a key we issued for this lesson? */
export function isDocumentKeyFor(key: string, lessonId: string): boolean {
  return DOCUMENT_KEY_PATTERN.test(key) && key.startsWith(`lesson-docs/${lessonId}/`);
}

/**
 * Where the browser's own CORS test writes its eight bytes.
 *
 * `cors-probe/<random>.bin`, matching NEITHER `SLIDE_KEY_PATTERN` nor
 * `VIDEO_KEY_PATTERN` — and that is the point rather than an accident. The
 * diagnostics page needs a real upload to prove a real upload works, but a key
 * under `live/` or `lessons/` could, through some future bug, be adopted by a
 * row and served to a student as a slide or a video. This prefix can never be:
 * every read path in the app runs its key through one of the two patterns
 * above, and this one fails both.
 *
 * The object is deleted seconds after it arrives. The prefix is also the one
 * safe thing to sweep blindly if a delete ever fails.
 */
export function corsProbeKey(random: string): string {
  return `cors-probe/${random}.bin`;
}

/** Mirrors `corsProbeKey`. Used to refuse a key the browser did not get from us. */
export const CORS_PROBE_KEY_PATTERN = /^cors-probe\/[A-Za-z0-9_-]{8,64}\.bin$/;

/**
 * Where one profile photo lives: `avatars/<user id>/<random>.<ext>`.
 *
 * The user id is the prefix, so a key naming another student's photo is not a
 * key this code can construct and have accepted. The random name matters for
 * the same reason it does everywhere else: a predictable key plus a signed URL
 * is a way to read a file the paywall or the privacy rule was meant to cover.
 */
export const AVATAR_KEY_PATTERN = /^avatars\/[0-9a-f-]{36}\/[A-Za-z0-9_-]{8,64}\.(png|jpg|webp)$/;

export function avatarKey(userId: string, extension: string, random: string): string {
  return `avatars/${userId}/${random}.${extension}`;
}

/** Is this a key we issued for this user? */
export function isAvatarKeyFor(key: string, userId: string): boolean {
  return AVATAR_KEY_PATTERN.test(key) && key.startsWith(`avatars/${userId}/`);
}

/** A random, URL-safe object name. Shared by every upload path. */
export function objectName(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
