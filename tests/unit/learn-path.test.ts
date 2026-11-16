import { describe, expect, it } from 'vitest';
import type { Lesson } from '../../src/lib/content/types';
import {
  courseProgress,
  isCompleted,
  lessonState,
  neighbours,
  resumeLesson,
} from '../../src/lib/learn/path';

function lesson(id: string, extra: Partial<Lesson> = {}): Lesson {
  return {
    id,
    slug: id,
    title: `Leçon ${id}`,
    type: 'video',
    position: 0,
    duration_seconds: 600,
    is_preview: false,
    ...extra,
  } as Lesson;
}

const lessons = [lesson('a'), lesson('b'), lesson('c'), lesson('d')];
const rows = (entries: Record<string, string>) =>
  new Map(Object.entries(entries).map(([id, status]) => [id, { status }]));

describe('what counts as finished', () => {
  it('is a completed row, and nothing else', () => {
    expect(isCompleted({ status: 'completed' })).toBe(true);
    // A lesson the student un-marked keeps its row; it is not finished.
    expect(isCompleted({ status: 'in_progress' })).toBe(false);
    expect(isCompleted({ status: 'not_started' })).toBe(false);
    expect(isCompleted(undefined)).toBe(false);
    expect(isCompleted(null)).toBe(false);
  });
});

describe('the progress of a module', () => {
  it('counts finished lessons, not rows', () => {
    // The dashboard used to count every row, so `b` (un-marked) was a third
    // "finished" lesson there and not on the lesson page.
    const progress = rows({ a: 'completed', b: 'in_progress', c: 'completed' });
    expect(courseProgress(lessons, progress)).toEqual({
      done: 2,
      total: 4,
      percent: 50,
      complete: false,
    });
  });

  it('ignores progress on lessons that are not in the module', () => {
    const progress = rows({ a: 'completed', zz: 'completed' });
    expect(courseProgress(lessons, progress).done).toBe(1);
  });

  it('is complete only when every lesson is finished', () => {
    const all = rows({
      a: 'completed',
      b: 'completed',
      c: 'completed',
      d: 'completed',
    });
    expect(courseProgress(lessons, all)).toMatchObject({
      percent: 100,
      complete: true,
    });
  });

  it('an empty module is 0 %, and never "complete"', () => {
    expect(courseProgress([], new Map())).toEqual({
      done: 0,
      total: 0,
      percent: 0,
      complete: false,
    });
  });

  it('rounds to a whole percent', () => {
    const three = [lesson('a'), lesson('b'), lesson('c')];
    expect(courseProgress(three, rows({ a: 'completed' })).percent).toBe(33);
    expect(courseProgress(three, rows({ a: 'completed', b: 'completed' })).percent).toBe(67);
  });
});

describe('where "Reprendre" lands', () => {
  it('on the first lesson of a module not started', () => {
    expect(resumeLesson(lessons, new Map())?.id).toBe('a');
  });

  it('on the first unfinished lesson, in order', () => {
    expect(resumeLesson(lessons, rows({ a: 'completed', b: 'completed' }))?.id).toBe('c');
  });

  it('on a skipped lesson before later finished ones', () => {
    // Finished 1 and 3, skipped 2: the gap is what is left to do.
    expect(resumeLesson(lessons, rows({ a: 'completed', c: 'completed' }))?.id).toBe('b');
  });

  it('on a lesson the student un-marked', () => {
    expect(resumeLesson(lessons, rows({ a: 'in_progress' }))?.id).toBe('a');
  });

  it('back on the first lesson once everything is finished', () => {
    const all = rows({
      a: 'completed',
      b: 'completed',
      c: 'completed',
      d: 'completed',
    });
    expect(resumeLesson(lessons, all)?.id).toBe('a');
  });

  it('nowhere in a module with no lessons', () => {
    expect(resumeLesson([], new Map())).toBeNull();
  });
});

describe('the lesson before and the lesson after', () => {
  it('in the middle', () => {
    const { index, previous, next } = neighbours(lessons, 'b');
    expect(index).toBe(1);
    expect(previous?.id).toBe('a');
    expect(next?.id).toBe('c');
  });

  it('the first has no previous, the last no next', () => {
    expect(neighbours(lessons, 'a').previous).toBeNull();
    expect(neighbours(lessons, 'a').next?.id).toBe('b');
    expect(neighbours(lessons, 'd').next).toBeNull();
    expect(neighbours(lessons, 'd').previous?.id).toBe('c');
  });

  it('a lesson that is not in the module has neither', () => {
    expect(neighbours(lessons, 'zz')).toEqual({
      index: -1,
      previous: null,
      next: null,
    });
  });
});

describe('how a lesson reads in the syllabus', () => {
  const base = {
    progress: rows({ a: 'completed' }),
    hasAccess: true,
    availableIds: null,
  };

  it('the page being read is "current", even when finished', () => {
    expect(lessonState({ ...base, lesson: lessons[0]!, currentId: 'a' })).toBe('current');
  });

  it('a finished lesson is "done"', () => {
    expect(lessonState({ ...base, lesson: lessons[0]!, currentId: 'b' })).toBe('done');
  });

  it('a held lesson with content for the group is "available"', () => {
    const availableIds = new Set(['a', 'b']);
    expect(lessonState({ ...base, availableIds, lesson: lessons[1]! })).toBe('available');
  });

  it('a held lesson the group has no content for yet is "upcoming"', () => {
    const availableIds = new Set(['a', 'b']);
    expect(lessonState({ ...base, availableIds, lesson: lessons[2]! })).toBe('upcoming');
  });

  it('nothing is "upcoming" when the group\'s content is not known', () => {
    // Staff, or a holder who has not chosen a group: no guess shown as fact.
    expect(lessonState({ ...base, availableIds: null, lesson: lessons[2]! })).toBe('available');
  });

  it('without access only a free preview is open', () => {
    const visitor = {
      progress: new Map(),
      hasAccess: false,
      availableIds: null,
    };
    expect(lessonState({ ...visitor, lesson: lesson('p', { is_preview: true }) })).toBe(
      'available',
    );
    expect(lessonState({ ...visitor, lesson: lessons[1]! })).toBe('locked');
  });
});
