import { describe, expect, it } from 'vitest';
import { loginSchema, registerSchema, resetPasswordSchema } from '@/lib/validation/auth';
import { isAllowedProviderEmail } from '@/lib/validation/email-providers';

const valid = {
  fullName: 'Sihem Benali',
  email: 'Sihem@Gmail.com ',
  password: 'motdepasse1',
  passwordConfirm: 'motdepasse1',
  locale: 'fr' as const,
  acceptTerms: true as const,
};

describe('registerSchema', () => {
  it('normalises the email so two casings cannot become two accounts', () => {
    const parsed = registerSchema.parse(valid);
    expect(parsed.email).toBe('sihem@gmail.com');
  });

  it('rejects a password with no digit', () => {
    const result = registerSchema.safeParse({ ...valid, password: 'motdepasse', passwordConfirm: 'motdepasse' });
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((i) => i.message === 'validation.passwordWeak')).toBe(true);
  });

  it('rejects a password under eight characters', () => {
    const result = registerSchema.safeParse({ ...valid, password: 'mdp1', passwordConfirm: 'mdp1' });
    expect(result.success).toBe(false);
  });

  it('reports a mismatch against the confirmation field, not the password', () => {
    const result = registerSchema.safeParse({ ...valid, passwordConfirm: 'autrechose1' });
    expect(result.success).toBe(false);
    const issue = result.error?.issues.find((i) => i.message === 'validation.passwordMismatch');
    expect(issue?.path).toEqual(['passwordConfirm']);
  });

  it('refuses signup when the terms are not accepted', () => {
    const result = registerSchema.safeParse({ ...valid, acceptTerms: false });
    expect(result.success).toBe(false);
  });

  it('has no way to set a role — that is the database trigger’s job', () => {
    const parsed = registerSchema.parse({ ...valid, role: 'admin' } as never);
    expect(parsed).not.toHaveProperty('role');
  });

  it('accepts the mailbox providers the school allows', () => {
    for (const email of [
      'a@gmail.com',
      'a@googlemail.com',
      'a@hotmail.fr',
      'a@outlook.co.uk',
      'a@live.com',
      'a@yahoo.com.br',
      'a@ymail.com',
      'a@rocketmail.com',
      'a@icloud.com',
      'a@me.com',
      'a@mac.com',
    ]) {
      expect(registerSchema.safeParse({ ...valid, email }).success, email).toBe(true);
    }
  });

  it('refuses a valid address from any other provider', () => {
    const result = registerSchema.safeParse({ ...valid, email: 'sihem@example.fr' });
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((i) => i.message === 'validation.emailProvider')).toBe(true);
  });
});

describe('isAllowedProviderEmail', () => {
  it('is not fooled by a lookalike subdomain', () => {
    expect(isAllowedProviderEmail('a@mail.gmail.com')).toBe(false);
    expect(isAllowedProviderEmail('a@notyahoo.fr')).toBe(false);
  });

  it('ignores casing and a missing or empty address', () => {
    expect(isAllowedProviderEmail('a@HOTMAIL.FR')).toBe(true);
    expect(isAllowedProviderEmail('')).toBe(false);
    expect(isAllowedProviderEmail(null)).toBe(false);
    expect(isAllowedProviderEmail('a@')).toBe(false);
  });
});

describe('loginSchema', () => {
  it('does not enforce password rules on sign-in', () => {
    // An account created before a rule change must still be able to log in.
    expect(loginSchema.safeParse({ email: 'a@b.fr', password: 'x' }).success).toBe(true);
  });

  it('keeps accepting any provider — the rule is for new accounts only', () => {
    // The office opens accounts on school addresses, and a rule introduced
    // later must never lock an existing student out of their own account.
    expect(loginSchema.safeParse({ email: 'ancien@example.fr', password: 'x' }).success).toBe(true);
  });
});

describe('resetPasswordSchema', () => {
  it('applies the same strength rules as registration', () => {
    expect(resetPasswordSchema.safeParse({ password: 'court1', passwordConfirm: 'court1' }).success).toBe(false);
    expect(resetPasswordSchema.safeParse({ password: 'motdepasse1', passwordConfirm: 'motdepasse1' }).success).toBe(true);
  });
});
