/**
 * The pdf.js worker bundles, imported for their side effects.
 *
 * Only reached when a browser refuses a module worker: importing the worker
 * bundle registers it globally and pdf.js then runs it on the main thread. They
 * ship no typings of their own, and they export nothing worth typing.
 *
 * The modern engine itself is declared too: only the legacy build ships a
 * `.d.mts` beside its bundle, and the modern one is loaded first. Both are cast
 * to the root package's types where they are used.
 */
declare module 'pdfjs-dist/build/pdf.mjs';
declare module 'pdfjs-dist/build/pdf.worker.min.mjs';
declare module 'pdfjs-dist/legacy/build/pdf.worker.min.mjs';
