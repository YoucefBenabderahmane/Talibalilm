/**
 * Deciding whether an upload is really a PDF.
 *
 * Same rule as the image and video sniffers, for the same reason: the browser's
 * content type is a hint and is trivially forged, and a presigned PUT lets the
 * browser write anything at all to the key we signed. The truth is knowable
 * only after the bytes exist, read back out of the bucket.
 *
 * Pure and exported so the rule is tested without a bucket.
 */

/** 1 GB. A scanned term's material, carried by one presigned PUT. */
export const MAX_DOCUMENT_BYTES = 1024 * 1024 * 1024;

/**
 * The PDF magic, from the leading bytes.
 *
 * A PDF starts `%PDF-` followed by a version. That is the whole test: unlike an
 * image there is no ambiguity to resolve, and reading the whole document back
 * off the bucket is not something a confirm should do — a file that lies past
 * these bytes fails in the reader, not here.
 */
export function sniffPdf(bytes: Uint8Array): boolean {
  const magic = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
  if (bytes.length < magic.length) return false;
  return magic.every((byte, index) => bytes[index] === byte);
}

export type DocumentCheck =
  | { ok: true; contentType: 'application/pdf' }
  | { ok: false; error: 'documentTooLarge' | 'notAPdf' };

/** Validate an uploaded object by its measured size and its actual bytes. */
export function checkDocument(head: Uint8Array, size: number): DocumentCheck {
  // Size first: an object over the cap is refused whatever it contains, and the
  // figure passed in is the one MEASURED from the bucket, never the one the
  // browser announced before uploading.
  if (size > MAX_DOCUMENT_BYTES) return { ok: false, error: 'documentTooLarge' };
  if (size <= 0) return { ok: false, error: 'notAPdf' };
  if (!sniffPdf(head)) return { ok: false, error: 'notAPdf' };
  return { ok: true, contentType: 'application/pdf' };
}
