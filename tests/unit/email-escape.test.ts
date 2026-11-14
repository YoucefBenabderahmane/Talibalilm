import { describe, expect, it } from 'vitest';
import { escapeHtml } from '@/lib/email/escape';

describe('escapeHtml', () => {
  it('neutralises markup typed into a name', () => {
    expect(escapeHtml('<a href="https://evil.example">Cliquez</a>')).toBe(
      '&lt;a href=&quot;https://evil.example&quot;&gt;Cliquez&lt;/a&gt;',
    );
    expect(escapeHtml("O'Brien & fils")).toBe('O&#39;Brien &amp; fils');
  });

  it('leaves plain text, numbers and emptiness readable', () => {
    expect(escapeHtml('Fatima Zahra')).toBe('Fatima Zahra');
    expect(escapeHtml(300)).toBe('300');
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });
});
