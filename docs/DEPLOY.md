# Deploying to Vercel

Two accounts are needed and neither can be created from here: **Supabase** (the
database) and **Vercel** (the hosting).

The site builds and the public pages render *before* Supabase exists — the
catalogue falls back to fixture data — so you can deploy first and connect the
database second.

---

## 1. Supabase project

Create it at https://supabase.com/dashboard — **choose an EU region**
(Frankfurt or Paris). The school operates in France and GDPR requires student
data to stay in the EU. This cannot be changed later without migrating.

From **Project Settings → API**, copy three values:

| Value | Goes to |
|---|---|
| Project URL | `NEXT_PUBLIC_SUPABASE_URL` |
| `anon` / publishable key | `NEXT_PUBLIC_SUPABASE_ANON_KEY` |
| `service_role` / secret key | `SUPABASE_SERVICE_ROLE_KEY` — **server only** |

The anon key is safe in the browser: what it can do is decided by the RLS
policies, which is the whole design. The service-role key bypasses RLS
entirely — never prefix it `NEXT_PUBLIC_`.

**There is no Postgres connection string here.** The app talks to Supabase over
its REST API, so no `DATABASE_URL` and no pooler setting belongs in Vercel. The
direct / transaction / session pooler choice only matters for the CLI and
`psql` in step 2.

## 2. Apply the migrations

With the CLI, which picks the right connection for you:

```bash
npx supabase link --project-ref <your-project-ref>
npx supabase db push
```

Or paste each file from `supabase/migrations/` into the SQL editor, **in
filename order**:

1. `20260910120000_profiles.sql` — profiles, roles, the signup trigger
2. `20260910140000_courses.sql` — courses, modules, lessons, the content gate
3. `20260911090000_locale_en.sql` — the second locale becomes English
4. `20260911100000_commerce.sql` — cursus, products, packs, orders, entitlements
5. `20260911140000_offerings_and_payments.sql` — time slots, payment settings

Do **not** apply anything from `supabase/tests/` — `00_local_harness.sql` fakes
the `auth` schema for offline testing and would collide with Supabase's real one.

If you are connecting by hand rather than through the CLI: use the **direct**
connection, or the **session pooler** if your network is IPv4-only. Never the
**transaction pooler** (port 6543) for migrations — it holds no session state
and drops prepared statements, so DDL fails in ways that are hard to read.

## 3. Starter catalogue

`supabase/seed.sql` creates the two disciplines (Sciences du Coran, Sciences du
Fiqh), both cursus, year one of the Approfondi programme, and every offering at
300 € as an opening price. It is idempotent, so running it twice changes
nothing.

```bash
psql "$DATABASE_URL" -f supabase/seed.sql
```

Or paste it into the SQL editor. Every price in it is a placeholder to change
in **Admin → Tarifs** — nothing about it is a decision baked into the code.

## 3b. The in-database sweep (optional)

`supabase/cron.sql` schedules the database-only housekeeping — cancelling
abandoned checkouts, expiring entitlements, closing stale rooms, pruning
rate-limit windows — with pg_cron, every fifteen minutes, inside Postgres. No
function invocation, no Supabase egress. Enable **pg_cron** under Database →
Extensions first, then run the file in the SQL editor.

Without it, the app's `/api/cron/sweep` still runs those jobs on the hourly
GitHub workflow — the coupon release window is just longer. Both are
idempotent, so enabling pg_cron later is a plain re-run of the file.

## 4. Auth redirect URLs

**Authentication → URL Configuration**:

- **Site URL**: `https://your-domain.com`
- **Redirect URLs**: add `https://your-domain.com/auth/callback`

If this list and `NEXT_PUBLIC_SITE_URL` disagree, every verification and
password-reset link breaks. Add your Vercel preview domain too if you use
previews.

## 5. Vercel project

Import the repo at https://vercel.com/new. Framework detection handles the
rest — there is no `vercel.json` to write.

```
NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
NEXT_PUBLIC_SITE_URL=https://your-domain.com
```

Set the first three for **Production, Preview and Development**.

Set `NEXT_PUBLIC_SITE_URL` for **Production only**. Left unset elsewhere, the
app falls back to `VERCEL_URL`, which is the only value correct per deployment —
set it everywhere and previews will send PayPal return URLs and password-reset
links to the production domain.

## 6. First admin

Everyone is created as `student`; the signup trigger ignores any role in the
client-supplied metadata, on purpose. Register through the site first, then
promote yourself once from the SQL editor:

```sql
update public.profiles set role = 'admin' where id = (
  select id from auth.users where email = 'you@example.com'
);
```

`/admin/courses`, `/admin/cursus`, `/admin/pricing`, `/admin/packs` and
`/admin/payments` open from there. `/admin/payments` is admin-only; the rest are
open to instructors too.

## 7. PayPal

Either set the environment variables in Vercel:

```
PAYPAL_ENVIRONMENT=sandbox        # or live
PAYPAL_CLIENT_ID=...
PAYPAL_CLIENT_SECRET=...
PAYPAL_WEBHOOK_ID=...
```

…or leave them unset and fill in **Admin → Paiement** instead. Environment
variables win when both are present, and the admin form says so. Vercel's
encrypted store is the better place for the secret; the database row is the
convenience path.

Either way, create the webhook in the PayPal developer dashboard:

- **URL**: `https://your-domain.com/api/paypal/webhook`
- **Event**: `PAYMENT.CAPTURE.COMPLETED`

Then paste the webhook's id into `PAYPAL_WEBHOOK_ID` or the admin form. PayPal
has no shared signing secret — verification is a call back to PayPal's own API
using that id, so **without it every webhook is refused**. That is the correct
failure, not a bug, but it means a student who closes the tab on PayPal's page
after approving would not get their access until you fix it.

Test with a sandbox business account before switching `PAYPAL_ENVIRONMENT` to
`live`.

## 8. Granting access by hand

The office cash route is the supported way: generate a 100 %-off coupon and give
the student the code. To grant access directly — a scholarship, a teacher, a
test — insert an entitlement:

```sql
-- One course, for a year.
insert into public.entitlements (user_id, scope, course_id, delivery, expires_at)
select u.id, 'course', c.id, 'online', now() + interval '365 days'
from auth.users u, public.courses c
where u.email = 'you@example.com' and c.slug = 'sciences-du-coran';

-- Or the whole institute, which is what the old membership used to mean.
insert into public.entitlements (user_id, scope, expires_at, note)
select id, 'site', now() + interval '365 days', 'scholarship'
from auth.users where email = 'you@example.com';
```

Sign in and open a locked lesson — it should render. Sign out and open the same
URL — you should be sent to the login page. Open the course page signed out and
the syllabus is visible but no video id appears anywhere in the payload.

## 9. Regenerate the database types

`src/lib/supabase/database.types.ts` is hand-written to match the migrations.
Once the schema is live, replace it with the generated version:

```bash
npx supabase gen types typescript --linked > src/lib/supabase/database.types.ts
```

---

## Verifying the deployment

```bash
npm run typecheck && npm run lint && npm test && npm run build
npm run test:e2e     # 52 tests against a production build
npm run test:rls     # 105 policy assertions — needs any reachable Postgres 15+
```

With `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` present in
the environment, `test:e2e` additionally runs the REST-API tests that hit
PostgREST with the public anon key the way an attacker would: reading
`lesson_content` past the previews, inserting an entitlement, opening an order,
listing coupons. Without them those skip, and the SQL policy tests carry the
same guarantee.

---

## Before taking real money

- **Rate limiting is in-process.** `src/lib/rate-limit.ts` holds counters in
  memory, which on serverless means per-instance and reset on every cold start.
  Coupon redemption is where brute force pays, so this wants Upstash Redis or
  Postgres counters before launch.
- **No audit trail on service-role writes.** Orders and entitlements are created
  by a key that bypasses RLS. There is no table recording who did what.
- **The legal pages are placeholders.** `messages/*.json` says as much in
  `legal.placeholder`; real text has to come from the school's counsel before
  selling anything.

## Not yet wired

`.env.example` lists keys for Resend, LiveKit, Cloudflare R2 and Bunny Stream.
Nothing reads them yet — they are listed so the Vercel project is configured
once rather than at each phase. Live classes, recordings and video playback
fill them in.
