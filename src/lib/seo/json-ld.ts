/**
 * JSON-LD that is safe to put inside a `<script>` tag.
 *
 * `JSON.stringify` escapes quotes but not `<`, so a value containing
 * `</script><script>…` ends the data block and starts a script of its own in
 * every visitor's browser. The values here come from the catalogue and from
 * instructors' profiles — an instructor's own display name is one of them — so
 * the string has to be made inert rather than trusted.
 *
 * The escapes are the JSON ones (`<`), so the result is still valid JSON
 * and search engines read it unchanged. The two Unicode line separators are
 * built from their code points rather than written as escapes: a raw U+2028
 * in a source file is a line terminator to the parser.
 */
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

export function jsonLdScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .split(LINE_SEPARATOR)
    .join('\\u2028')
    .split(PARAGRAPH_SEPARATOR)
    .join('\\u2029');
}
