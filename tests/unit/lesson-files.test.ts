import { describe, expect, it } from 'vitest';
import { documentRows, readDocuments } from '../../src/lib/content/lesson-files';

describe('reading the attachments column', () => {
  it('keeps the entries that are documents', () => {
    const value = [
      {
        key: 'lesson-docs/a/one.pdf',
        filename: 'one.pdf',
        bytes: 10,
        uploaded_at: '2026-01-01T00:00:00.000Z',
      },
      { key: 'lesson-docs/a/two.pdf', filename: 'two.pdf', bytes: 20 },
    ];
    expect(readDocuments(value)).toEqual([
      {
        key: 'lesson-docs/a/one.pdf',
        filename: 'one.pdf',
        bytes: 10,
        uploadedAt: '2026-01-01T00:00:00.000Z',
      },
      { key: 'lesson-docs/a/two.pdf', filename: 'two.pdf', bytes: 20, uploadedAt: null },
    ]);
  });

  it('never trusts the shape: anything else is dropped', () => {
    expect(readDocuments(null)).toEqual([]);
    expect(readDocuments('a string')).toEqual([]);
    expect(readDocuments([null, 4, 'x', {}, { key: '' }, { key: 'k' }, { filename: 'f' }])).toEqual(
      [],
    );
  });

  it('reads an unreadable size and date as absent rather than NaN', () => {
    expect(readDocuments([{ key: 'k', filename: 'f', bytes: 'big', uploaded_at: 4 }])).toEqual([
      { key: 'k', filename: 'f', bytes: 0, uploadedAt: null },
    ]);
  });
});

describe('writing the attachments column', () => {
  it('writes the stored shape, deduplicated by key, order kept', () => {
    expect(
      documentRows([
        { key: 'a', filename: 'a.pdf', bytes: 1, uploadedAt: '2026-01-01T00:00:00.000Z' },
        { key: 'a', filename: 'a.pdf', bytes: 1, uploadedAt: '2026-01-01T00:00:00.000Z' },
        { key: 'b', filename: 'b.pdf', bytes: 2, uploadedAt: null },
      ]),
    ).toEqual([
      { key: 'a', filename: 'a.pdf', bytes: 1, uploaded_at: '2026-01-01T00:00:00.000Z' },
      { key: 'b', filename: 'b.pdf', bytes: 2, uploaded_at: expect.any(String) },
    ]);
  });
});
