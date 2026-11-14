import { describe, expect, it } from 'vitest';
import { safeNextPath } from '@/lib/auth/next-path';

describe('safeNextPath', () => {
  it('keeps an ordinary same-site path, with its query and hash', () => {
    expect(safeNextPath('/dashboard')).toBe('/dashboard');
    expect(safeNextPath('/en/courses/fiqh?tab=2#inscription')).toBe(
      '/en/courses/fiqh?tab=2#inscription',
    );
    expect(safeNextPath('/live/abc-123')).toBe('/live/abc-123');
  });

  it('falls back when there is nothing usable', () => {
    expect(safeNextPath(null)).toBe('/dashboard');
    expect(safeNextPath(undefined)).toBe('/dashboard');
    expect(safeNextPath('')).toBe('/dashboard');
    expect(safeNextPath('dashboard')).toBe('/dashboard');
    expect(safeNextPath(null, '/courses')).toBe('/courses');
  });

  it('refuses anything that leaves the site', () => {
    expect(safeNextPath('https://evil.example')).toBe('/dashboard');
    expect(safeNextPath('//evil.example')).toBe('/dashboard');
    expect(safeNextPath('//evil.example/path')).toBe('/dashboard');
    expect(safeNextPath('javascript:alert(1)')).toBe('/dashboard');
    expect(safeNextPath('mailto:x@evil.example')).toBe('/dashboard');
  });

  it('refuses the backslash forms browsers read as a slash', () => {
    // The regression: `/\evil.example` passed the old `//` check and browsers
    // navigate it as `//evil.example`.
    expect(safeNextPath('/\\evil.example')).toBe('/dashboard');
    expect(safeNextPath('/\\\\evil.example')).toBe('/dashboard');
    expect(safeNextPath('/\\/evil.example')).toBe('/dashboard');
    expect(safeNextPath('/dashboard\\..\\evil')).toBe('/dashboard');
  });

  it('refuses whitespace and control characters', () => {
    expect(safeNextPath('/ dashboard')).toBe('/dashboard');
    expect(safeNextPath('/dashboard\n')).toBe('/dashboard');
    expect(safeNextPath('/\t//evil.example')).toBe('/dashboard');
    expect(safeNextPath('/dash\u0000board')).toBe('/dashboard');
  });

  it('refuses credentials smuggled into the path', () => {
    expect(safeNextPath('/@evil.example')).toBe('/@evil.example'); // a path, harmless
    expect(safeNextPath('//user:pw@evil.example')).toBe('/dashboard');
  });

  it('keeps a percent-encoded backslash, which stays a path', () => {
    expect(safeNextPath('/%5Cevil.example')).toBe('/%5Cevil.example');
  });
});
