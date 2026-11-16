import { describe, expect, it } from 'vitest';
import {
  resolveAttendance,
  summarizeAttendance,
  wasHeld,
  type AttendanceSession,
} from '../../src/lib/live/attendance';

const held: AttendanceSession = {
  status: 'ended',
  startedAt: '2026-11-10T18:00:00Z',
  endedAt: '2026-11-10T20:00:00Z',
};
const before = '2026-11-01T09:00:00Z';
const after = '2026-11-12T09:00:00Z';

describe('a class that was held', () => {
  it('started and is over', () => {
    expect(wasHeld(held)).toBe(true);
  });

  it('is not one that was cancelled, still running, or only scheduled', () => {
    expect(wasHeld({ ...held, status: 'cancelled' })).toBe(false);
    expect(wasHeld({ ...held, status: 'live', endedAt: null })).toBe(false);
    expect(wasHeld({ status: 'scheduled', startedAt: null, endedAt: null })).toBe(false);
  });

  it('is not one that was closed without ever being opened', () => {
    // Ended from the admin list, never started: nobody can have missed it.
    expect(wasHeld({ status: 'ended', startedAt: null, endedAt: held.endedAt })).toBe(false);
  });
});

describe('the automatic answer', () => {
  it('present when the student opened the room', () => {
    expect(
      resolveAttendance({ session: held, joined: true, mark: null, memberSince: before }),
    ).toEqual({ status: 'present', corrected: false });
  });

  it('absent when they were in the group and did not', () => {
    expect(
      resolveAttendance({ session: held, joined: false, mark: null, memberSince: before }),
    ).toEqual({ status: 'absent', corrected: false });
  });

  it('a class before the student joined the group does not count', () => {
    expect(
      resolveAttendance({ session: held, joined: false, mark: null, memberSince: after }),
    ).toBeNull();
  });

  it('nor does one for a student who is in no group', () => {
    expect(
      resolveAttendance({ session: held, joined: false, mark: null, memberSince: null }),
    ).toBeNull();
  });

  it('joining the group at the very moment the class starts counts', () => {
    expect(
      resolveAttendance({
        session: held,
        joined: false,
        mark: null,
        memberSince: held.startedAt,
      }),
    ).toEqual({ status: 'absent', corrected: false });
  });

  it('a class they attended shows as present even if they joined the group later', () => {
    // Moved from another group by the office: the row proves they were there.
    expect(
      resolveAttendance({ session: held, joined: true, mark: null, memberSince: after }),
    ).toEqual({ status: 'present', corrected: false });
  });

  it('a class that was not held has no answer, whatever else is true', () => {
    const cancelled = { ...held, status: 'cancelled' };
    expect(
      resolveAttendance({ session: cancelled, joined: true, mark: 'absent', memberSince: before }),
    ).toBeNull();
  });
});

describe("the teacher's correction", () => {
  it('wins over an absence: an on-site student was there', () => {
    expect(
      resolveAttendance({ session: held, joined: false, mark: 'present', memberSince: before }),
    ).toEqual({ status: 'present', corrected: true });
  });

  it('wins over a presence: the room was opened and left before the class', () => {
    expect(
      resolveAttendance({ session: held, joined: true, mark: 'absent', memberSince: before }),
    ).toEqual({ status: 'absent', corrected: true });
  });

  it('can excuse', () => {
    expect(
      resolveAttendance({ session: held, joined: false, mark: 'excused', memberSince: before }),
    ).toEqual({ status: 'excused', corrected: true });
  });

  it('makes a class count for a student who joined the group afterwards', () => {
    expect(
      resolveAttendance({ session: held, joined: false, mark: 'excused', memberSince: after }),
    ).toEqual({ status: 'excused', corrected: true });
  });
});

describe('the summary', () => {
  it('counts only the classes that count', () => {
    expect(
      summarizeAttendance([
        { status: 'present' },
        { status: 'present' },
        { status: 'absent' },
        { status: 'excused' },
        null,
      ]),
    ).toEqual({ total: 4, present: 2, absent: 1, excused: 1 });
  });

  it('is all zeros for no classes', () => {
    expect(summarizeAttendance([])).toEqual({ total: 0, present: 0, absent: 0, excused: 0 });
  });
});
