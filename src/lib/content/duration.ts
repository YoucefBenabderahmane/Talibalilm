/**
 * How long a lesson lasts, as stored and as shown.
 *
 * `lessons.duration_seconds` used to be only what someone typed in « Durée
 * (minutes) », and nobody types it for a class recording: the editor and the
 * module page read « 0 min » beside a two-hour video. An uploaded video now
 * gives the lesson its own length when the lesson has none, and a length
 * nobody knows shows nothing rather than a zero that reads as "empty lesson".
 */

/** A day: the `lessons_duration_sane` check, and `updateLesson`'s 1440 minutes. */
export const MAX_LESSON_SECONDS = 86_400;

/**
 * The length worth storing from a video's own metadata, in whole seconds, or
 * `null` when it gives nothing usable.
 *
 * A recording straight from the browser reports `Infinity` (it has no
 * duration until it is indexed), a file the browser cannot read reports
 * `NaN`, and more than a day would be refused by the column's check.
 */
export function videoSeconds(raw: number | null | undefined): number | null {
  if (raw == null || !Number.isFinite(raw)) return null;
  const seconds = Math.round(raw);
  return seconds >= 1 && seconds <= MAX_LESSON_SECONDS ? seconds : null;
}

/**
 * The minutes shown beside a lesson, or `null` when nobody knows its length.
 *
 * At least 1 for any known length: a 20-second clip reads « 1 min », never
 * « 0 min ».
 */
export function lessonMinutes(seconds: number | null | undefined): number | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.max(1, Math.round(seconds / 60));
}
