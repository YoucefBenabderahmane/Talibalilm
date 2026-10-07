import { describe, expect, it } from 'vitest';
import { checkDocument, MAX_DOCUMENT_BYTES, sniffPdf } from '../../src/lib/media/document';

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);

describe('the PDF magic', () => {
  it('accepts %PDF- and rejects everything else', () => {
    expect(sniffPdf(PDF)).toBe(true);
    expect(sniffPdf(new TextEncoder().encode('%PDF-1.4 with a body'))).toBe(true);
    // A zip, which is what a renamed office document looks like.
    expect(sniffPdf(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe(false);
    expect(sniffPdf(new TextEncoder().encode('%PD'))).toBe(false);
    expect(sniffPdf(new Uint8Array(0))).toBe(false);
  });
});

describe('a document upload', () => {
  it('accepts a PDF within the cap', () => {
    expect(checkDocument(PDF, 1024)).toEqual({ ok: true, contentType: 'application/pdf' });
  });

  it('refuses anything over the cap, whatever it contains', () => {
    expect(checkDocument(PDF, MAX_DOCUMENT_BYTES + 1)).toEqual({
      ok: false,
      error: 'documentTooLarge',
    });
  });

  it('refuses an empty object or one that is not a PDF', () => {
    expect(checkDocument(PDF, 0)).toEqual({ ok: false, error: 'notAPdf' });
    expect(checkDocument(new TextEncoder().encode('not a pdf at all'), 16)).toEqual({
      ok: false,
      error: 'notAPdf',
    });
  });
});
