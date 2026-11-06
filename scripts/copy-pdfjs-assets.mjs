// pdf.js's helper files, served from public/ so the PDF workers can fetch them.
//
// The library decodes scanned pages (JPEG 2000, JBIG2) with WebAssembly modules,
// draws fonts a PDF names without embedding from its own font files, and needs
// character maps and colour profiles for some documents. None of that ships
// inside the JavaScript bundle. Without these files a scanned PDF opens and
// every page comes out blank: the "second PDF does not work" a teacher met.
//
// Copied, not committed: the files must match the installed pdf.js exactly, so
// they are taken from node_modules on every install and build, into a folder
// named after the version (a new pdf.js never reads an old decoder from cache).
import { cpSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'node_modules', 'pdfjs-dist');

if (!existsSync(dist)) {
  console.warn('[pdfjs-assets] pdfjs-dist is not installed; nothing to copy');
  process.exit(0);
}

const { version } = JSON.parse(readFileSync(join(dist, 'package.json'), 'utf8'));
const out = join(root, 'public', 'pdfjs');

rmSync(out, { recursive: true, force: true });
for (const folder of ['wasm', 'standard_fonts', 'cmaps', 'iccs']) {
  cpSync(join(dist, folder), join(out, version, folder), { recursive: true });
}
console.log(`[pdfjs-assets] pdf.js ${version} helper files copied to public/pdfjs/${version}/`);
