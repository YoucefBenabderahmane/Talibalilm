import { describe, expect, it } from 'vitest';
import { jsonLdScript } from '@/lib/seo/json-ld';

describe('jsonLdScript', () => {
  it('cannot close the script tag it is placed in', () => {
    const out = jsonLdScript({ name: '</script><script>alert(1)</script>' });
    expect(out).not.toContain('</script>');
    expect(out).not.toContain('<');
    expect(out).not.toContain('>');
  });

  it('is still the same JSON once parsed', () => {
    const value = {
      '@type': 'Course',
      name: 'Fiqh <débutants> & plus',
      instructor: { name: 'Nom </script>' },
      line: 'a' + String.fromCharCode(0x2028) + 'b',
    };
    expect(JSON.parse(jsonLdScript(value))).toEqual(value);
  });

  it('leaves ordinary text alone', () => {
    expect(jsonLdScript({ a: 'Institut Talib al-ʿIlm', n: 3 })).toBe(
      '{"a":"Institut Talib al-ʿIlm","n":3}',
    );
  });
});
