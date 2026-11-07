import { describe, expect, it } from 'vitest';
import { groupAt, groupDeck, storedBase, type DeckGroupItem } from '@/lib/live/deck-groups';

const live = (source: string, page: number, filename: string): DeckGroupItem => ({
  kind: 'live',
  id: `${source}:${page}`,
  filename,
});
const stored = (id: string, filename: string): DeckGroupItem => ({ kind: 'stored', id, filename });

describe('groupDeck', () => {
  it('makes one section per PDF opened live, in the order they were opened', () => {
    const items = [
      live('a', 1, 'cours-1.pdf'),
      live('a', 2, 'cours-1.pdf'),
      live('a', 3, 'cours-1.pdf'),
      live('b', 1, 'cours-2.pdf'),
      live('b', 2, 'cours-2.pdf'),
      live('c', 1, 'annexe.pdf'),
    ];
    expect(groupDeck(items)).toEqual([
      { key: 'live:a', title: 'cours-1.pdf', start: 0, count: 3 },
      { key: 'live:b', title: 'cours-2.pdf', start: 3, count: 2 },
      { key: 'live:c', title: 'annexe.pdf', start: 5, count: 1 },
    ]);
  });

  it('keeps two PDFs with the same name apart: the source decides, not the name', () => {
    const groups = groupDeck([live('a', 1, 'cours.pdf'), live('b', 1, 'cours.pdf')]);
    expect(groups.map((g) => g.key)).toEqual(['live:a', 'live:b']);
  });

  it('groups uploaded pages of one PDF under its name, and leaves a lone image alone', () => {
    const groups = groupDeck([
      stored('1', 'fiqh-01.jpg'),
      stored('2', 'fiqh-02.jpg'),
      stored('3', 'photo.png'),
      live('x', 1, 'hadith.pdf'),
    ]);
    expect(groups).toEqual([
      { key: 'stored:fiqh', title: 'fiqh', start: 0, count: 2 },
      { key: 'stored:photo.png', title: 'photo.png', start: 2, count: 1 },
      { key: 'live:x', title: 'hadith.pdf', start: 3, count: 1 },
    ]);
  });

  it('gives the same file appearing twice, apart, two distinct keys', () => {
    const groups = groupDeck([
      stored('1', 'a-01.jpg'),
      stored('2', 'b-01.jpg'),
      stored('3', 'a-02.jpg'),
    ]);
    expect(new Set(groups.map((g) => g.key)).size).toBe(3);
  });

  it('is empty for an empty deck', () => {
    expect(groupDeck([])).toEqual([]);
  });
});

describe('groupAt', () => {
  const groups = groupDeck([
    live('a', 1, 'one.pdf'),
    live('a', 2, 'one.pdf'),
    live('b', 1, 'two.pdf'),
  ]);

  it('finds the section on stage, at both of its edges', () => {
    expect(groupAt(groups, 0)?.key).toBe('live:a');
    expect(groupAt(groups, 1)?.key).toBe('live:a');
    expect(groupAt(groups, 2)?.key).toBe('live:b');
  });

  it('finds nothing when no slide is on stage, or past the end', () => {
    expect(groupAt(groups, -1)).toBeNull();
    expect(groupAt(groups, 3)).toBeNull();
  });
});

describe('storedBase', () => {
  it('drops the page number a converted PDF page carries', () => {
    expect(storedBase('cours-03.jpg')).toBe('cours');
    expect(storedBase('cours-12.webp')).toBe('cours');
    expect(storedBase('Cours final-1.PNG')).toBe('Cours final');
  });

  it('leaves any other name as it is', () => {
    expect(storedBase('photo.png')).toBe('photo.png');
    expect(storedBase('2024-plan.pdf')).toBe('2024-plan.pdf');
  });
});
