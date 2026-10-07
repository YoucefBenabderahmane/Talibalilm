/**
 * The `attachments` column, read as lesson documents.
 *
 * The column is `jsonb` with a CHECK that says "an array" and nothing more, and
 * one hand edit — in the SQL editor, in a future feature — can put anything in
 * it. Every reader goes through here rather than trusting the shape, so a
 * malformed entry is skipped instead of crashing a lesson page.
 */

/** One uploaded document, as the app uses it. */
export interface LessonDocument {
  /** The R2 key. Never a URL: a signed link is minted per reader, per request. */
  key: string;
  filename: string;
  bytes: number;
  /** ISO date, or null when the entry predates the field. */
  uploadedAt: string | null;
}

/**
 * The shape written back to the column.
 *
 * A type alias rather than an interface on purpose: the column is the `Json`
 * union, and only a structural type carries the implicit index signature that
 * union needs.
 */
export type LessonDocumentRow = {
  key: string;
  filename: string;
  bytes: number;
  uploaded_at: string;
};

/**
 * Read whatever the column holds, keeping only entries that are documents.
 *
 * An entry with no key or no filename is not something a reader can do anything
 * with, and a bytes figure that is not a number shows as 0 rather than NaN.
 */
export function readDocuments(value: unknown): LessonDocument[] {
  if (!Array.isArray(value)) return [];

  const documents: LessonDocument[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    if (typeof row.key !== 'string' || row.key === '') continue;
    if (typeof row.filename !== 'string' || row.filename === '') continue;
    documents.push({
      key: row.key,
      filename: row.filename,
      bytes: typeof row.bytes === 'number' && Number.isFinite(row.bytes) ? row.bytes : 0,
      uploadedAt: typeof row.uploaded_at === 'string' ? row.uploaded_at : null,
    });
  }
  return documents;
}

/** The column shape for one document. */
export function documentRow(document: LessonDocument): LessonDocumentRow {
  return {
    key: document.key,
    filename: document.filename,
    bytes: document.bytes,
    uploaded_at: document.uploadedAt ?? new Date().toISOString(),
  };
}

/** The column shape for a whole list, deduplicated by key, order kept. */
export function documentRows(documents: LessonDocument[]): LessonDocumentRow[] {
  const seen = new Set<string>();
  const rows: LessonDocumentRow[] = [];
  for (const document of documents) {
    if (seen.has(document.key)) continue;
    seen.add(document.key);
    rows.push(documentRow(document));
  }
  return rows;
}
