import { describe, expect, it } from 'vitest';
import { authMode, isAuthOnly, withoutLocale } from '@/lib/supabase/auth-mode';

/**
 * Which auth check the middleware makes, per path.
 *
 * This split is what keeps `getClaims()` from becoming a login loop. The
 * pages that decide whether a signed-in visitor belongs (`/login`,
 * `/register`, `/forgot-password`) must re-verify against the Auth server —
 * otherwise a still-valid token for a deleted user would bounce them:
 * `/dashboard` (guard says no) → `/login` (middleware says signed in) →
 * `/dashboard` → … for as long as the token lives.
 *
 * `/loginx` is the trap this test exists for: a naive `startsWith('/login')`
 * would classify it as auth-only and give it the wrong check.
 */

describe('withoutLocale', () => {
  it('strips a leading locale from every known one', () => {
    expect(withoutLocale('/fr/dashboard')).toBe('/dashboard');
    expect(withoutLocale('/en/dashboard')).toBe('/dashboard');
    expect(withoutLocale('/fr')).toBe('/');
    expect(withoutLocale('/en')).toBe('/');
  });

  it('keeps a path that only looks locale-prefixed', () => {
    // `/french` is not `fr` + `/ench`.
    expect(withoutLocale('/french')).toBe('/french');
    expect(withoutLocale('/encore')).toBe('/encore');
  });

  it('leaves locale-less and nested paths alone', () => {
    expect(withoutLocale('/dashboard')).toBe('/dashboard');
    expect(withoutLocale('/en/dashboard/courses/fiqh/lessons/x')).toBe(
      '/dashboard/courses/fiqh/lessons/x',
    );
  });
});

describe('authMode', () => {
  it('verifies the server on the auth pages, with or without a locale', () => {
    expect(authMode('/login')).toBe('verify');
    expect(authMode('/en/login')).toBe('verify');
    expect(authMode('/register')).toBe('verify');
    expect(authMode('/en/register')).toBe('verify');
    expect(authMode('/forgot-password')).toBe('verify');
    expect(authMode('/fr/forgot-password')).toBe('verify');
  });

  it('verifies a child of an auth page too', () => {
    expect(authMode('/login/callback')).toBe('verify');
    expect(authMode('/en/register/confirm')).toBe('verify');
  });

  it('does NOT count a path that merely starts with the same letters', () => {
    // The reason this is a function and not a `startsWith` in two places.
    expect(authMode('/loginx')).toBe('claims');
    expect(authMode('/en/loginx')).toBe('claims');
    expect(authMode('/register-interest')).toBe('claims');
  });

  it('uses the local check everywhere else', () => {
    expect(authMode('/')).toBe('claims');
    expect(authMode('/en')).toBe('claims');
    expect(authMode('/dashboard')).toBe('claims');
    expect(authMode('/en/dashboard/courses/fiqh/lessons/x')).toBe('claims');
    expect(authMode('/admin')).toBe('claims');
    expect(authMode('/reset-password')).toBe('claims');
    expect(authMode('/en/verify-email')).toBe('claims');
  });
});

describe('isAuthOnly', () => {
  it('is true only for the exact paths or their children', () => {
    expect(isAuthOnly('/login')).toBe(true);
    expect(isAuthOnly('/en/login')).toBe(true);
    expect(isAuthOnly('/login/help')).toBe(true);
    expect(isAuthOnly('/loginx')).toBe(false);
    expect(isAuthOnly('/dashboard')).toBe(false);
  });
});
