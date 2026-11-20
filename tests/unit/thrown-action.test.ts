import { describe, expect, it } from 'vitest';
import { UnrecognizedActionError } from 'next/dist/client/components/unrecognized-action-error';
import { thrownAction } from '@/components/admin/thrown-action';

describe('thrownAction', () => {
  it('tells a page older than the site to reload, keeping the browser’s words', () => {
    // What Next throws in a page opened before a new version went live.
    const stale = new UnrecognizedActionError(
      'Server Action "7f3a" was not found on the server. \nRead more: https://nextjs.org/docs/messages/failed-to-find-server-action',
    );
    const state = thrownAction(stale);
    expect(state.ok).toBe(false);
    expect(state.error).toBe('pageOutdated');
    expect(state.detail).toContain('was not found on the server');
  });

  it('reports anything else as a failed upload, with what was thrown', () => {
    expect(thrownAction(new TypeError('Failed to fetch'))).toEqual({
      ok: false,
      error: 'uploadFailed',
      detail: 'TypeError: Failed to fetch',
    });
    expect(thrownAction('no network').detail).toBe('no network');
  });
});
