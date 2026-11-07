/**
 * The deck, as the teacher thinks of it: one section per file.
 *
 * The room keeps one list of pages — the uploaded slides, then the PDFs opened
 * live on the teacher's machine — because the class follows a single index.
 * The panel and the stage's page controls show it per file instead: the PDF
 * on stage is open, the others are folded away under their names, and « page
 * 3 / 12 » counts within the PDF being taught rather than across everything
 * opened since the lesson began.
 *
 * Pure, so the boundaries are tested without a browser.
 */

export interface DeckGroupItem {
  kind: 'stored' | 'live';
  /** A live page's id is `${sourceId}:${page}`; a stored slide's is its row id. */
  id: string;
  filename: string;
}

export interface DeckGroup {
  /** Stable while the deck does not change; unique even if a file is opened twice. */
  key: string;
  title: string;
  /** Index of the group's first page in the room's single list. */
  start: number;
  count: number;
}

/**
 * The file a stored page came from. A PDF converted for upload is stored as
 * one image per page, named `cours-03.jpg`; the pages of one file share the
 * part before the number. An image uploaded on its own keeps its own name.
 */
export function storedBase(filename: string): string {
  return filename.replace(/-\d+\.(?:jpe?g|png|webp)$/i, '');
}

function sourceOf(item: DeckGroupItem): string {
  if (item.kind === 'stored') return `stored:${storedBase(item.filename)}`;
  const cut = item.id.lastIndexOf(':');
  return `live:${cut > 0 ? item.id.slice(0, cut) : item.id}`;
}

/** Consecutive pages from the same file, in deck order. */
export function groupDeck(items: readonly DeckGroupItem[]): DeckGroup[] {
  const groups: DeckGroup[] = [];
  const seen = new Map<string, number>();
  let lastSource: string | null = null;

  items.forEach((item, index) => {
    const source = sourceOf(item);
    const last = groups[groups.length - 1];
    if (last && source === lastSource) {
      last.count += 1;
      return;
    }
    // The same file twice, apart, is two sections; their keys must differ.
    const occurrence = seen.get(source) ?? 0;
    seen.set(source, occurrence + 1);
    groups.push({
      key: occurrence === 0 ? source : `${source}#${occurrence}`,
      title: item.kind === 'live' ? item.filename : storedBase(item.filename),
      start: index,
      count: 1,
    });
    lastSource = source;
  });

  return groups;
}

/** The section holding the page at `index`, or null when nothing is on stage. */
export function groupAt(groups: readonly DeckGroup[], index: number): DeckGroup | null {
  if (index < 0) return null;
  return groups.find((group) => index >= group.start && index < group.start + group.count) ?? null;
}
