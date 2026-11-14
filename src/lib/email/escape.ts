/**
 * Text that is going into HTML, made inert.
 *
 * The office's notification e-mails are HTML, and some of what they carry was
 * typed by a stranger: the name on a new registration, the subject of a
 * contact message. Interpolated raw, `<a href="https://evil…">` in a signup
 * name becomes a working link in the school's inbox, styled like our own
 * mail. Everything that reaches `render()` goes through here first.
 */
export function escapeHtml(value: string | number | null | undefined): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
