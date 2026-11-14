-- ---------------------------------------------------------------------------
-- Policy tests for commerce.
--
-- The gate stopped being a boolean. "Is a member" became "may read THIS
-- course", and the ways to earn that are now: bought the module, enrolled in a
-- cursus whose programme covers it in the mode you paid for, or hold a
-- site-wide comp. Every one of those is a way to get it wrong, so every one is
-- asserted here — including the two that a naive implementation gets wrong:
-- a cursus student reading another YEAR of the programme, and an on-site
-- student reading the ONLINE programme's modules.
-- ---------------------------------------------------------------------------

\set ON_ERROR_STOP on

create or replace function public.assert(ok boolean, what text)
returns void language plpgsql as $$
begin
  if not ok then raise exception 'FAILED: %', what; end if;
  raise notice '  ok  %', what;
end $$;
-- Callable from the roles the tests switch to: since the function-grants
-- migration a new function starts closed, as it does on Supabase once that
-- migration has run.
grant execute on function public.assert(boolean, text) to anon, authenticated, service_role;

/** Can the current role read this lesson's gated content? */
create or replace function public.can_read(lid uuid)
returns boolean language sql stable as $$
  select exists (select 1 from public.lesson_content where lesson_id = lid);
$$;
grant execute on function public.can_read(uuid) to anon, authenticated, service_role;

-- --- fixtures -------------------------------------------------------------

insert into auth.users (id, email, raw_user_meta_data) values
  ('a0000000-0000-0000-0000-000000000001', 'module@test.fr',   '{"full_name":"Achète un module"}'::jsonb),
  ('a0000000-0000-0000-0000-000000000002', 'online@test.fr',   '{"full_name":"Approfondi en ligne"}'::jsonb),
  ('a0000000-0000-0000-0000-000000000003', 'onsite@test.fr',   '{"full_name":"Approfondi présentiel"}'::jsonb),
  ('a0000000-0000-0000-0000-000000000004', 'nobody@test.fr',   '{"full_name":"Sans rien"}'::jsonb),
  ('a0000000-0000-0000-0000-000000000005', 'admin@test.fr',    '{"full_name":"Direction"}'::jsonb),
  ('a0000000-0000-0000-0000-000000000006', 'bonus@test.fr',    '{"full_name":"Reçoit un bonus"}'::jsonb),
  ('a0000000-0000-0000-0000-000000000007', 'plan@test.fr',     '{"full_name":"Paie en trois fois"}'::jsonb);

update public.profiles set role = 'admin' where id = 'a0000000-0000-0000-0000-000000000005';

-- Five courses, each with one module and one gated lesson. c1 also has a free
-- preview, so "sees only the preview" has something to see.
insert into public.courses (id, slug, title, status, published_at) values
  ('c0000000-0000-0000-0000-000000000001', 'fiqh',     'Fiqh',            'published', now()),
  ('c0000000-0000-0000-0000-000000000002', 'aqida',    'Aqida',           'published', now()),
  ('c0000000-0000-0000-0000-000000000003', 'arabe',    'Langue arabe',    'published', now()),
  ('c0000000-0000-0000-0000-000000000004', 'tafsir',   'Tafsir',          'published', now()),
  ('c0000000-0000-0000-0000-000000000005', 'histoire', 'Histoire',        'published', now());

insert into public.modules (id, course_id, title, position)
select ('d0000000-0000-0000-0000-00000000000' || n)::uuid,
       ('c0000000-0000-0000-0000-00000000000' || n)::uuid,
       'Module ' || n, 1
from generate_series(1, 5) as n;

insert into public.lessons (id, module_id, title, slug, position, duration_seconds, is_preview)
select ('e0000000-0000-0000-0000-00000000000' || n)::uuid,
       ('d0000000-0000-0000-0000-00000000000' || n)::uuid,
       'Leçon ' || n, 'lecon-' || n, 1, 1800, false
from generate_series(1, 5) as n;

insert into public.lessons (id, module_id, title, slug, position, duration_seconds, is_preview) values
  ('e0000000-0000-0000-0000-000000000009', 'd0000000-0000-0000-0000-000000000001',
   'Extrait', 'extrait', 2, 600, true);

insert into public.lesson_content (lesson_id, content, video_provider, video_id)
select id, 'Contenu réservé.', 'bunny', 'SECRET-' || substr(id::text, 1, 8)
from public.lessons;

-- Two cursus, as the school sells them.
-- The schema now SEEDS the two real cursus (20260914120000), because the app
-- cannot function without them. These fixtures are a separate, deliberately
-- differently-slugged pair: this suite is about policies, not about the seeded
-- rows, and reusing their slugs made the whole file die on a unique violation
-- rather than testing anything.
insert into public.cursus (id, slug, kind, title, year_count, status) values
  ('f0000000-0000-0000-0000-000000000001', 'fixture-module', 'module',
   'Cursus Module', 1, 'published'),
  ('f0000000-0000-0000-0000-000000000002', 'fixture-approfondi', 'approfondi',
   'Cursus Approfondi', 3, 'published'),
  ('f0000000-0000-0000-0000-000000000003', 'fixture-secret', 'approfondi',
   'Pas encore annoncé', 1, 'draft');

-- The programmes. Note that the ONLINE and ON-SITE Approfondi cover different
-- modules — that difference is the whole point of the delivery column.
insert into public.cursus_courses (cursus_id, course_id, delivery, year_index, position) values
  ('f0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000001', 'online', 1, 1),
  ('f0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000002', 'online', 1, 2),
  ('f0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000004', 'online', 2, 1),
  ('f0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000003', 'presentiel', 1, 1);

insert into public.products
  (id, kind, course_id, cursus_id, year_index, delivery, price_cents, status) values
  ('11110000-0000-0000-0000-000000000001', 'module', 'c0000000-0000-0000-0000-000000000001',
   null, 1, 'online', 18000, 'published'),
  ('11110000-0000-0000-0000-000000000002', 'module', 'c0000000-0000-0000-0000-000000000003',
   null, 1, 'online', 22000, 'published'),
  ('11110000-0000-0000-0000-000000000003', 'cursus', null,
   'f0000000-0000-0000-0000-000000000002', 1, 'online', 69000, 'published'),
  ('11110000-0000-0000-0000-000000000004', 'module', 'c0000000-0000-0000-0000-000000000005',
   null, 1, 'online', 15000, 'draft');

-- The offer the school asked for: buy Arabic, the second module is free.
insert into public.packs (id, slug, title, delivery, pricing, status) values
  ('22220000-0000-0000-0000-000000000001', 'arabe-offert', 'Arabe + module offert',
   'online', 'sum', 'published'),
  ('22220000-0000-0000-0000-000000000002', 'pack-brouillon', 'Pack en préparation',
   'online', 'sum', 'draft');

insert into public.pack_items (pack_id, product_id, is_free, position) values
  ('22220000-0000-0000-0000-000000000001', '11110000-0000-0000-0000-000000000002', false, 1),
  ('22220000-0000-0000-0000-000000000001', '11110000-0000-0000-0000-000000000001', true, 2);

insert into public.coupons (code, percent_off, max_redemptions, is_office, batch) values
  ('CAISSE-0001', 100, 1, true, 'sept-2026'),
  ('CAISSE-0002', 100, 1, true, 'sept-2026');

-- Who holds what.
insert into public.entitlements
  (user_id, scope, course_id, cursus_id, year_index, delivery, expires_at) values
  -- Bought the fiqh module outright, online.
  ('a0000000-0000-0000-0000-000000000001', 'course', 'c0000000-0000-0000-0000-000000000001',
   null, 1, 'online', now() + interval '300 days'),
  -- Year 1 of the online Approfondi.
  ('a0000000-0000-0000-0000-000000000002', 'cursus', null,
   'f0000000-0000-0000-0000-000000000002', 1, 'online', now() + interval '300 days'),
  -- Year 1 of the ON-SITE Approfondi.
  ('a0000000-0000-0000-0000-000000000003', 'cursus', null,
   'f0000000-0000-0000-0000-000000000002', 1, 'presentiel', now() + interval '300 days');

\echo ''
\echo '=== commerce policy tests ==='

do $$
begin
  raise notice 'the gate — a module bought à la carte';
  call auth.login_as('a0000000-0000-0000-0000-000000000001');

  perform public.assert(public.can_read('e0000000-0000-0000-0000-000000000001'),
    'the module you bought opens');
  perform public.assert(not public.can_read('e0000000-0000-0000-0000-000000000002'),
    'a module you did NOT buy stays shut — this is the whole point of the change');
  perform public.assert(not public.can_read('e0000000-0000-0000-0000-000000000005'),
    'buying one module does not open the catalogue');
  perform public.assert(public.can_read('e0000000-0000-0000-0000-000000000009'),
    'free previews still open for everyone');

  reset role;
end $$;

do $$
begin
  raise notice 'the gate — the online Approfondi programme';
  call auth.login_as('a0000000-0000-0000-0000-000000000002');

  perform public.assert(public.can_read('e0000000-0000-0000-0000-000000000001'),
    'every module in your year of the programme opens (1/2)');
  perform public.assert(public.can_read('e0000000-0000-0000-0000-000000000002'),
    'every module in your year of the programme opens (2/2)');
  perform public.assert(not public.can_read('e0000000-0000-0000-0000-000000000004'),
    'NEXT YEAR of the programme stays shut until you pay for it');
  -- The mode is organisational, not a second paywall: a cursus opens its
  -- modules whichever way the student attends. The school asked for this —
  -- an on-site student must be able to study online.
  perform public.assert(public.can_read('e0000000-0000-0000-0000-000000000003'),
    'a module only in the on-site programme is open to the online student too');
  perform public.assert(not public.can_read('e0000000-0000-0000-0000-000000000005'),
    'a module in no programme at all stays shut');

  reset role;
end $$;

do $$
begin
  raise notice 'the gate — the on-site Approfondi programme';
  call auth.login_as('a0000000-0000-0000-0000-000000000003');

  perform public.assert(public.can_read('e0000000-0000-0000-0000-000000000003'),
    'the on-site programme opens its own modules');
  perform public.assert(public.can_read('e0000000-0000-0000-0000-000000000001'),
    'and the online programme too — one enrolment, both modes (1/2)');
  perform public.assert(public.can_read('e0000000-0000-0000-0000-000000000002'),
    'and the online programme too — one enrolment, both modes (2/2)');

  reset role;
end $$;

do $$
begin
  raise notice 'the gate — no entitlement at all';
  call auth.login_as('a0000000-0000-0000-0000-000000000004');

  perform public.assert((select count(*) from public.lesson_content) = 1,
    'a signed-in account with nothing bought sees exactly the previews');
  perform public.assert(
    (select count(*) from public.lesson_content
      where video_id like 'SECRET-e0000000%' and lesson_id <> 'e0000000-0000-0000-0000-000000000009') = 0,
    'not even a direct query BY the secret video id returns a gated row');

  reset role;
end $$;

do $$
begin
  raise notice 'the catalogue is public — it is the sales page';
  call auth.logout();

  -- Counted among THIS SUITE'S fixtures rather than the whole table. The
  -- schema seeds two real cursus of its own, so a bare count says "4" and the
  -- assertion becomes a statement about the seed instead of about the policy.
  -- What is being proved is that `published` is visible and `draft` is not.
  perform public.assert(
    (select count(*) from public.cursus where slug like 'fixture-%') = 2,
    'an anonymous visitor reads the published cursus');
  perform public.assert(
    not exists (select 1 from public.cursus where slug = 'fixture-secret'),
    'and not the draft one');
  perform public.assert(
    (select count(*) from public.cursus where slug = 'cursus-secret') = 0,
    'a draft cursus is invisible before it is announced');
  perform public.assert((select count(*) from public.products) = 3,
    'published prices are public — a shopper has to see them');
  perform public.assert(
    (select count(*) from public.products where status = 'draft') = 0,
    'a draft price is not on display');
  perform public.assert((select count(*) from public.packs) = 1,
    'a published offer is public');
  perform public.assert((select count(*) from public.pack_items) = 2,
    'and so is what is in it');
  perform public.assert((select count(*) from public.cursus_courses) = 4,
    'the programme itself is public — it is what the student is choosing between');

  reset role;
end $$;

do $$
declare refused boolean := false;
begin
  raise notice 'coupons are never readable by a client';

  -- A signed-in student holds SELECT on the table but no policy passes, so the
  -- rows are simply not there.
  call auth.login_as('a0000000-0000-0000-0000-000000000001');
  perform public.assert((select count(*) from public.coupons) = 0,
    'a student cannot list coupons — a percent-off code is worth money');
  perform public.assert(
    (select count(*) from public.coupons where code = 'CAISSE-0001') = 0,
    'nor read one by guessing its code');
  reset role;

  -- An anonymous visitor does not even hold the grant, so the refusal happens
  -- one layer earlier. Two different mechanisms, both closed.
  call auth.logout();
  begin
    perform count(*) from public.coupons;
  exception when insufficient_privilege then refused := true;
  end;
  perform public.assert(refused,
    'an anonymous visitor is refused the coupons table outright');
  reset role;

  call auth.login_as('a0000000-0000-0000-0000-000000000005');
  perform public.assert((select count(*) from public.coupons) = 2,
    'the admin who issues them can read them');
  reset role;
end $$;

do $$
declare wrote boolean := false;
begin
  raise notice 'orders and entitlements are the server''s to write';
  call auth.login_as('a0000000-0000-0000-0000-000000000001');

  perform public.assert((select count(*) from public.orders) = 0,
    'a student with no orders sees none');

  begin
    insert into public.orders (user_id, route, delivery, subtotal_cents, total_cents)
    values ('a0000000-0000-0000-0000-000000000001', 'paypal', 'online', 0, 0);
    wrote := true;
  exception when insufficient_privilege then wrote := false;
  end;
  perform public.assert(not wrote,
    'a client CANNOT create an order — it would be naming its own total');

  wrote := false;
  begin
    insert into public.entitlements (user_id, scope, course_id, delivery, expires_at)
    values ('a0000000-0000-0000-0000-000000000001', 'course',
            'c0000000-0000-0000-0000-000000000002', 'online', now() + interval '365 days');
    wrote := true;
  exception when insufficient_privilege then wrote := false;
  end;
  perform public.assert(not wrote,
    'a client CANNOT grant itself an entitlement');

  wrote := false;
  begin
    update public.entitlements set expires_at = now() + interval '10 years';
    wrote := true;
  exception when insufficient_privilege then wrote := false;
  end;
  perform public.assert(not wrote,
    'nor extend the one it has');

  reset role;
end $$;

do $$
begin
  raise notice 'staff visibility';
  call auth.login_as('a0000000-0000-0000-0000-000000000005');
  perform public.assert((select count(*) from public.entitlements) = 3,
    'an admin can see who holds what — the school has to be able to answer the phone');
  perform public.assert((select count(*) from public.products) = 4,
    'staff see draft prices too');
  reset role;
end $$;

-- --- the arithmetic -------------------------------------------------------

do $$
declare ok boolean := false;
begin
  raise notice 'the money constraints';

  begin
    insert into public.orders (id, user_id, route, delivery, subtotal_cents, total_cents)
    values ('33330000-0000-0000-0000-000000000001',
            'a0000000-0000-0000-0000-000000000004', 'paypal', 'online', 99900, 99900);
    insert into public.order_items
      (order_id, product_id, kind, course_id, delivery, unit_price_cents, duration_days)
    values ('33330000-0000-0000-0000-000000000001', '11110000-0000-0000-0000-000000000001',
            'module', 'c0000000-0000-0000-0000-000000000001', 'online', 18000, 365);
    set constraints all immediate;
    ok := true;
  exception when others then ok := false;
  end;
  perform public.assert(not ok,
    'an order whose items do not sum to its subtotal is REFUSED by the database');

  ok := false;
  begin
    insert into public.orders (user_id, route, delivery, subtotal_cents, discount_cents, total_cents)
    values ('a0000000-0000-0000-0000-000000000004', 'paypal', 'online', 18000, 0, 17000);
    ok := true;
  exception when check_violation then ok := false;
  end;
  perform public.assert(not ok,
    'a total that is not subtotal minus discount is refused');

  ok := false;
  begin
    insert into public.orders (user_id, route, delivery, subtotal_cents, discount_cents, total_cents)
    values ('a0000000-0000-0000-0000-000000000004', 'office', 'online', 18000, 20000, -2000);
    ok := true;
  exception when check_violation then ok := false;
  end;
  perform public.assert(not ok,
    'a discount larger than the subtotal cannot make a negative order');
end $$;

-- --- coupon redemption ----------------------------------------------------

do $$
declare first_claim uuid; second_claim uuid;
begin
  raise notice 'coupon redemption is atomic';

  first_claim := public.redeem_coupon('CAISSE-0001');
  perform public.assert(first_claim is not null, 'a fresh single-use code redeems once');

  second_claim := public.redeem_coupon('CAISSE-0001');
  perform public.assert(second_claim is null,
    'and the second attempt is refused — the WHERE clause, not a read-then-write');

  perform public.assert(public.redeem_coupon('caisse-0002') is not null,
    'codes are matched case-insensitively so the desk can type them in lower case');

  perform public.assert(public.redeem_coupon('PAS-UN-CODE') is null,
    'an unknown code is refused rather than raising');
end $$;

-- --- the grant path -------------------------------------------------------

do $$
declare granted integer;
begin
  raise notice 'granting an order — the one path both payment routes take';

  insert into public.orders
    (id, user_id, route, delivery, subtotal_cents, total_cents, status, paid_at)
  values ('33330000-0000-0000-0000-000000000002',
          'a0000000-0000-0000-0000-000000000004', 'paypal', 'online', 18000, 18000,
          'paid', now());
  insert into public.order_items
    (order_id, product_id, kind, course_id, delivery, unit_price_cents, duration_days)
  values ('33330000-0000-0000-0000-000000000002', '11110000-0000-0000-0000-000000000001',
          'module', 'c0000000-0000-0000-0000-000000000001', 'online', 18000, 365);

  granted := public.grant_order_entitlements('33330000-0000-0000-0000-000000000002');
  perform public.assert(granted = 1, 'a paid order hands over exactly its items');

  perform public.assert(
    public.has_course_access('c0000000-0000-0000-0000-000000000001',
                             'a0000000-0000-0000-0000-000000000004'),
    'and the buyer can now read the course');

  granted := public.grant_order_entitlements('33330000-0000-0000-0000-000000000002');
  perform public.assert(granted = 0,
    'replaying the same order grants nothing — PayPal retries its webhooks');

  perform public.assert(
    (select count(*) from public.entitlements
      where user_id = 'a0000000-0000-0000-0000-000000000004') = 1,
    'and leaves exactly one entitlement behind, not two');
end $$;

-- --- a bonus hands over the gift ------------------------------------------
--
-- "Buy Arabic, French is free" is priced by zeroing the gift's line, which
-- means the gift has to BE a line — `bonusItems` in the app is what puts it
-- there. The entitlement then comes out of the same loop as everything else,
-- and this is what proves the gift is granted rather than merely discounted.

do $$
declare granted integer;
begin
  raise notice 'a bonus grants the gift, not only a discount';

  insert into public.orders
    (id, user_id, route, delivery, subtotal_cents, total_cents, status, paid_at)
  values ('33330000-0000-0000-0000-000000000009',
          'a0000000-0000-0000-0000-000000000006', 'paypal', 'online', 22000, 22000,
          'paid', now());

  insert into public.order_items
    (order_id, product_id, kind, course_id, delivery, unit_price_cents, duration_days, is_free)
  values
    ('33330000-0000-0000-0000-000000000009', '11110000-0000-0000-0000-000000000002',
     'module', 'c0000000-0000-0000-0000-000000000003', 'online', 22000, 365, false),
    ('33330000-0000-0000-0000-000000000009', '11110000-0000-0000-0000-000000000001',
     'module', 'c0000000-0000-0000-0000-000000000001', 'online', 0, 365, true);

  granted := public.grant_order_entitlements('33330000-0000-0000-0000-000000000009');
  perform public.assert(granted = 2, 'both the paid module and the gift are handed over');

  perform public.assert(
    public.has_course_access('c0000000-0000-0000-0000-000000000003',
                             'a0000000-0000-0000-0000-000000000006'),
    'the buyer can read what they paid for');
  perform public.assert(
    public.has_course_access('c0000000-0000-0000-0000-000000000001',
                             'a0000000-0000-0000-0000-000000000006'),
    'and the gift too — a bonus that granted nothing would be a lie on the card');
end $$;

-- --- paying in three, and what a missed installment costs ------------------
--
-- The plan lives on one order: the first payment opens the course, the rest
-- are invoices on a schedule, and an OVERDUE one closes the door — inside
-- `has_course_access`, so every gate (lessons, content, slides, live) closes
-- together and none of them can forget.

do $$
declare plan_order uuid := '33330000-0000-0000-0000-000000000010';
begin
  raise notice 'an overdue installment closes the door';

  insert into public.orders
    (id, user_id, route, delivery, subtotal_cents, total_cents, status, paid_at,
     plan_size, paid_cents)
  values (plan_order, 'a0000000-0000-0000-0000-000000000007', 'paypal', 'online',
          22000, 22000, 'paid', now(), 3, 7334);

  insert into public.order_items
    (order_id, product_id, kind, course_id, delivery, unit_price_cents, duration_days)
  values (plan_order, '11110000-0000-0000-0000-000000000002',
          'module', 'c0000000-0000-0000-0000-000000000003', 'online', 22000, 365);

  perform public.grant_order_entitlements(plan_order);

  -- 7334 + 7333 + 7333 = 22000 exactly.
  insert into public.installments
    (order_id, sequence, amount_cents, due_at, status, paid_at)
  values
    (plan_order, 1, 7334, now() - interval '1 day', 'paid', now() - interval '1 day'),
    (plan_order, 2, 7333, now() + interval '3 months', 'pending', null),
    (plan_order, 3, 7333, now() + interval '6 months', 'pending', null);

  perform public.assert(
    public.has_course_access('c0000000-0000-0000-0000-000000000003',
                             'a0000000-0000-0000-0000-000000000007'),
    'the first payment opens the course while the rest are still due');

  perform public.assert(
    (select paid_cents from public.orders where id = plan_order) = 7334,
    'and the balance stays on the order, not on a second one');

  -- The second falls due.
  update public.installments set due_at = now() - interval '1 hour'
   where order_id = plan_order and sequence = 2;

  perform public.assert(
    not public.has_course_access('c0000000-0000-0000-0000-000000000003',
                                 'a0000000-0000-0000-0000-000000000007'),
    'an overdue installment closes it again — the same function every gate asks');

  -- Paid.
  update public.installments set status = 'paid', paid_at = now()
   where order_id = plan_order and sequence = 2;

  perform public.assert(
    public.has_course_access('c0000000-0000-0000-0000-000000000003',
                             'a0000000-0000-0000-0000-000000000007'),
    'and paying it opens the door immediately');

  perform public.assert(
    public.has_course_access('c0000000-0000-0000-0000-000000000003',
                             'a0000000-0000-0000-0000-000000000007'),
    'a future installment is not an overdue one');
end $$;

do $$
declare before_expiry timestamptz; after_expiry timestamptz;
begin
  raise notice 'renewing early stacks instead of restarting';

  select expires_at into before_expiry from public.entitlements
   where user_id = 'a0000000-0000-0000-0000-000000000004';

  insert into public.orders
    (id, user_id, route, delivery, subtotal_cents, total_cents, status, paid_at)
  values ('33330000-0000-0000-0000-000000000003',
          'a0000000-0000-0000-0000-000000000004', 'paypal', 'online', 18000, 18000,
          'paid', now());
  insert into public.order_items
    (order_id, product_id, kind, course_id, delivery, unit_price_cents, duration_days)
  values ('33330000-0000-0000-0000-000000000003', '11110000-0000-0000-0000-000000000001',
          'module', 'c0000000-0000-0000-0000-000000000001', 'online', 18000, 365);

  perform public.grant_order_entitlements('33330000-0000-0000-0000-000000000003');

  select expires_at into after_expiry from public.entitlements
   where user_id = 'a0000000-0000-0000-0000-000000000004';

  perform public.assert(
    after_expiry > before_expiry + interval '364 days',
    'the days you had left are added to, not thrown away (rule 6)');
  perform public.assert(
    (select count(*) from public.entitlements
      where user_id = 'a0000000-0000-0000-0000-000000000004') = 1,
    'and there is still exactly one row for that course');
end $$;

do $$
declare refused boolean := false;
begin
  raise notice 'an unpaid order grants nothing';

  insert into public.orders
    (id, user_id, route, delivery, subtotal_cents, total_cents, status)
  values ('33330000-0000-0000-0000-000000000004',
          'a0000000-0000-0000-0000-000000000001', 'paypal', 'online', 22000, 22000, 'pending');
  insert into public.order_items
    (order_id, product_id, kind, course_id, delivery, unit_price_cents, duration_days)
  values ('33330000-0000-0000-0000-000000000004', '11110000-0000-0000-0000-000000000002',
          'module', 'c0000000-0000-0000-0000-000000000003', 'online', 22000, 365);

  begin
    perform public.grant_order_entitlements('33330000-0000-0000-0000-000000000004');
  exception when check_violation then refused := true;
  end;

  perform public.assert(refused,
    'a pending order cannot be cashed into access — the capture has to land first');
  perform public.assert(
    not public.has_course_access('c0000000-0000-0000-0000-000000000003',
                                 'a0000000-0000-0000-0000-000000000001'),
    'and nothing opened');
end $$;

do $$
declare swept integer;
begin
  raise notice 'expiry is decided by the clock, not the status column';

  -- Backdate the whole period, not just the expiry: `entitlements_period`
  -- insists a row cannot end before it starts, which is itself worth having.
  update public.entitlements
     set starts_at = now() - interval '366 days',
         expires_at = now() - interval '1 day'
   where user_id = 'a0000000-0000-0000-0000-000000000001';

  perform public.assert(
    not public.has_course_access('c0000000-0000-0000-0000-000000000001',
                                 'a0000000-0000-0000-0000-000000000001'),
    'a row still flagged active but past its date grants nothing');

  swept := public.expire_entitlements();
  perform public.assert(swept >= 1, 'the nightly sweep tidies the flag afterwards');
  perform public.assert(
    (select status from public.entitlements
      where user_id = 'a0000000-0000-0000-0000-000000000001') = 'expired',
    'and the row now reads as expired');
end $$;

-- --- payment credentials --------------------------------------------------

do $$
declare refused boolean := false; status json;
begin
  raise notice 'the PayPal secret is out of reach of every browser session';

  update public.payment_settings
     set client_id = 'AXbogus', client_secret = 'SECRET-DO-NOT-LEAK',
         webhook_id = 'WH-123', enabled = true
   where id;

  -- An admin is the person who typed the secret in, and still cannot read it
  -- back: the table carries no grant for `authenticated` at all, so a stolen
  -- admin session cannot exfiltrate it.
  call auth.login_as('a0000000-0000-0000-0000-000000000005');
  begin
    perform count(*) from public.payment_settings;
  exception when insufficient_privilege then refused := true;
  end;
  perform public.assert(refused,
    'an ADMIN cannot select from payment_settings — the grant does not exist');

  status := public.payment_settings_status();
  perform public.assert((status ->> 'has_secret')::boolean,
    'the admin is told a secret is set');
  perform public.assert(status::text not like '%SECRET-DO-NOT-LEAK%',
    'but is never told what it is');
  perform public.assert(status ->> 'client_id' = 'AXbogus',
    'the client id comes back in full — PayPal publishes it in the browser anyway');
  reset role;

  refused := false;
  call auth.login_as('a0000000-0000-0000-0000-000000000001');
  begin
    perform public.payment_settings_status();
  exception when insufficient_privilege then refused := true;
  end;
  perform public.assert(refused, 'a student is refused the status too');
  reset role;
end $$;

do $$
declare ok boolean := false;
begin
  raise notice 'payment settings cannot be switched on half-configured';
  begin
    update public.payment_settings set client_secret = '', enabled = true where id;
    ok := true;
  exception when check_violation then ok := false;
  end;
  perform public.assert(not ok,
    'enabling PayPal without credentials is refused — it would fail at the worst moment');
end $$;

-- --- giving a coupon back -------------------------------------------------

do $$
declare claimed uuid;
begin
  raise notice 'an abandoned checkout hands its coupon back';

  claimed := public.redeem_coupon('CAISSE-0002');
  perform public.assert(claimed is null, 'the code from the earlier test is still spent');

  perform public.release_coupon(
    (select id from public.coupons where code = 'CAISSE-0002'));
  perform public.assert(public.redeem_coupon('CAISSE-0002') is not null,
    'and works again once the order that claimed it was cancelled');
end $$;

do $$
declare before_count integer; after_count integer;
begin
  raise notice 'a double release cannot invent redemptions';

  update public.coupons set redeemed_count = 0 where code = 'CAISSE-0001';
  perform public.release_coupon((select id from public.coupons where code = 'CAISSE-0001'));
  perform public.release_coupon((select id from public.coupons where code = 'CAISSE-0001'));

  select redeemed_count into after_count from public.coupons where code = 'CAISSE-0001';
  perform public.assert(after_count = 0,
    'the count floors at zero rather than going negative');
end $$;

-- --- one price per course, per mode, per slot ------------------------------

do $$
declare ok boolean := false;
begin
  raise notice 'the price list allows one row per slot and no more';

  -- The same course, same mode, a DIFFERENT slot: the school runs Sciences
  -- Islamiques on Friday evening and again on Saturday morning, at its own
  -- price. This has to be allowed.
  insert into public.products
    (kind, course_id, delivery, time_slot, price_cents, status, language)
  values ('module', 'c0000000-0000-0000-0000-000000000001', 'online',
          'weekend-matin', 25000, 'published', 'fr');
  perform public.assert(true, 'the same course may be sold again in another time slot');

  begin
    insert into public.products
      (kind, course_id, delivery, time_slot, price_cents, status, language)
    values ('module', 'c0000000-0000-0000-0000-000000000001', 'online',
            'weekend-matin', 19900, 'published', 'fr');
    ok := true;
  exception when unique_violation then ok := false;
  end;
  perform public.assert(not ok,
    'but two live prices for the SAME slot are refused — which one would be charged?');
end $$;

drop function public.can_read(uuid);
drop function public.assert(boolean, text);

\echo ''
\echo 'ALL COMMERCE POLICY TESTS PASSED'
\echo ''
