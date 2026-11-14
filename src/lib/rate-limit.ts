/**
 * Shared rate limiter, backed by a Postgres counter (audit B8).
 *
 * The limiter this replaces counted in one serverless instance's module scope
 * and reset on every cold start, so an attacker spreading requests across warm
 * instances — or simply waiting for one to recycle — was barely throttled.
 * Office coupon codes are worth a year of access, so that gap paid. The counter
 * now lives in the one place every instance already talks to: a single atomic
 * `rate_limit_hit` upsert does the increment and the limit test in the same
 * statement, so two racing requests cannot both slip under the cap.
 *
 * Fail-open. If the database is unreachable the whole app is already degraded,
 * and blocking every login on a throttle-check outage trades a security speed
 * bump for a site-wide outage. Supabase Auth's own per-project limits remain the
 * backstop for the auth endpoints underneath this.
 *
 * Called as the service role, not as the visitor. `rate_limit_hit` takes the
 * bucket, the limit and the window from its caller, so while it was open to
 * `anon` anyone with the public key could fill another person's `login:<ip>`
 * bucket and lock them out, or pass a window of years and leave rows the
 * pruner never reaches. Only this module names buckets now.
 */
import { createAdminClient } from '@/lib/supabase/server';
import { supabaseConfigured } from '@/lib/env';
import { reportError } from '@/lib/observability/report';

export interface RateLimitResult {
  ok: boolean;
  retryAfterSeconds: number;
}

interface HitResult {
  allowed: boolean;
  remaining: number;
  retry_after: number;
}

export async function rateLimit(
  key: string,
  { limit, windowMs }: { limit: number; windowMs: number },
): Promise<RateLimitResult> {
  // Nothing to count against when the database is not wired up. The endpoints
  // this guards already refuse to do their real work in that state.
  if (!supabaseConfigured) return { ok: true, retryAfterSeconds: 0 };
  // The same fail-open when the service key is not set (a preview without
  // secrets): nothing to count with, and nothing to report on every request.
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) return { ok: true, retryAfterSeconds: 0 };

  try {
    const supabase = createAdminClient();
    const { data, error } = await supabase.rpc('rate_limit_hit', {
      bucket: key,
      max_hits: limit,
      window_seconds: Math.max(1, Math.ceil(windowMs / 1000)),
    });
    if (error || !data) {
      reportError('rate-limit.hit', error ?? new Error('empty rate_limit_hit result'), { key });
      return { ok: true, retryAfterSeconds: 0 };
    }
    const result = data as unknown as HitResult;
    return { ok: result.allowed, retryAfterSeconds: result.retry_after ?? 0 };
  } catch (err) {
    reportError('rate-limit.hit', err, { key });
    return { ok: true, retryAfterSeconds: 0 };
  }
}

/** Best-effort client address. Spoofable, so it is a speed bump layered under Supabase's own limits. */
export function clientKey(headers: Headers, scope: string): string {
  const forwarded = headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return `${scope}:${forwarded ?? headers.get('x-real-ip') ?? 'unknown'}`;
}
