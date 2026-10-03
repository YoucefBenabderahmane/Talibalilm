-- ---------------------------------------------------------------------------
-- The catalogue the Playwright suite runs against.
--
-- `supabase db reset` applies this after `seed.sql`, so the e2e job and a
-- developer's local stack see exactly the same rows. The slugs here are the
-- ones `tests/e2e/*.spec.ts` navigate to — `fiqh-al-ibadat` in particular,
-- whose syllabus is the subject of the member-gate assertions.
--
-- Kept separate from `seed.sql` on purpose: that file is the school's opening
-- catalogue and will change with the school, while a test needs data that does
-- not move. Nothing here is meant to look like a real price list.
-- ---------------------------------------------------------------------------

-- --- the modules under test ------------------------------------------------

insert into public.courses
  (id, slug, title, subtitle, description, title_ar, tone, category, level,
   format, language, status, published_at, display_order, schedule,
   duration_weeks, objectives)
values
  ('e2e00000-0000-4000-8000-000000000001', 'fiqh-al-ibadat',
   'Jurisprudence islamique — Fiqh al-‘Ibādāt',
   'Purification, prière, jeûne et pèlerinage, avec leurs preuves',
   'Le module le plus suivi de l''institut. Chaque règle est rattachée à sa preuve, et les divergences entre écoles sont exposées calmement.',
   'فقه العبادات', 'sand', 'fiqh', 'all', 'hybride', 'fr', 'published',
   '2025-09-01T08:00:00.000Z', 1, 'Vendredi · 19h00 – 21h00', 20,
   '["Accomplir les actes d''adoration en connaissance de cause", "Rattacher une règle pratique à sa preuve"]'::jsonb),

  ('e2e00000-0000-4000-8000-000000000002', 'croyance-islamique-aqida',
   'Croyance islamique — ‘Aqīda',
   'Unicité, noms et attributs, foi et au-delà',
   'Le module d''entrée de tout cursus sérieux : les six piliers de la foi et la signification du tawhid.',
   'العقيدة الإسلامية', 'emerald', 'aqida', 'beginner', 'hybride', 'fr', 'published',
   '2025-09-01T08:00:00.000Z', 2, 'Samedi · 10h00 – 12h00', 12,
   '["Énoncer et comprendre les six piliers de la foi"]'::jsonb),

  ('e2e00000-0000-4000-8000-000000000003', 'sciences-du-hadith',
   'Les Sciences du Hadith',
   'Le statut de la Sunna, le voyage et les sciences du hadith',
   'Comment sait-on qu''un hadith est authentique ? La chaîne, la critique des rapporteurs, les degrés.',
   'علوم الحديث', 'indigo', 'hadith', 'all', 'hybride', 'fr', 'published',
   '2025-10-01T08:00:00.000Z', 3, 'Samedi · 14h00 – 16h00', 12,
   '["Distinguer sahīh, hasan, da‘īf et mawdū‘"]'::jsonb),

  ('e2e00000-0000-4000-8000-000000000004', 'exegese-du-coran-tafsir',
   'Exégèse du Qur’an — Tafsīr pratique',
   'Lecture commentée des sourates les plus récitées',
   'Un atelier de lecture : vocabulaire, contexte de descente, cohérence interne, puis les grands exégètes.',
   'التفسير', 'crimson', 'tafsir', 'intermediate', 'hybride', 'fr', 'published',
   '2025-10-15T08:00:00.000Z', 4, 'Dimanche · 14h00 – 16h00', 16,
   '["Expliquer un passage court avec méthode"]'::jsonb),

  ('e2e00000-0000-4000-8000-000000000005', 'langue-arabe-fondamental',
   'Langue arabe — niveau fondamental',
   'Lire, écrire et comprendre l''arabe littéraire à partir de zéro',
   'Un parcours complet pour poser les bases de la langue du Coran : lecture, morphologie et grammaire.',
   'اللغة العربية', 'teal', 'langue', 'beginner', 'hybride', 'ar', 'published',
   '2025-11-01T08:00:00.000Z', 5, 'Mardi · 18h30 – 20h00', 24,
   '["Lire un texte vocalisé couramment"]'::jsonb)
on conflict (id) do nothing;

-- --- the syllabus the member-gate tests read -------------------------------

insert into public.modules (id, course_id, title, position) values
  ('e2e10000-0000-4000-8000-000000000001', 'e2e00000-0000-4000-8000-000000000001', 'At-Tahāra — la purification', 1),
  ('e2e10000-0000-4000-8000-000000000002', 'e2e00000-0000-4000-8000-000000000001', 'As-Salāt — la prière', 2),
  ('e2e10000-0000-4000-8000-000000000003', 'e2e00000-0000-4000-8000-000000000001', 'Le jeûne et le pèlerinage', 3)
on conflict (id) do nothing;

insert into public.lessons
  (id, module_id, title, slug, type, position, duration_seconds, is_preview)
values
  ('e2e20000-0000-4000-8000-000000000001', 'e2e10000-0000-4000-8000-000000000001',
   'Les eaux et les impuretés', 'les-eaux-et-les-impuretes', 'video', 1, 2520, true),
  ('e2e20000-0000-4000-8000-000000000002', 'e2e10000-0000-4000-8000-000000000001',
   'Les ablutions, le ghusl et le tayammum', 'les-ablutions-le-ghusl-et-le-tayammum', 'video', 2, 3300, false),
  ('e2e20000-0000-4000-8000-000000000003', 'e2e10000-0000-4000-8000-000000000001',
   'Les règles propres aux femmes', 'les-regles-propres-aux-femmes', 'video', 3, 2880, false),
  ('e2e20000-0000-4000-8000-000000000004', 'e2e10000-0000-4000-8000-000000000002',
   'Conditions, piliers et obligations', 'conditions-piliers-et-obligations', 'video', 1, 3660, false),
  ('e2e20000-0000-4000-8000-000000000005', 'e2e10000-0000-4000-8000-000000000002',
   'Les invalidants et les oublis', 'les-invalidants-et-les-oublis', 'video', 2, 2820, false),
  ('e2e20000-0000-4000-8000-000000000006', 'e2e10000-0000-4000-8000-000000000002',
   'Contrôle — les piliers de la prière', 'controle-les-piliers-de-la-priere', 'quiz', 3, 900, false),
  ('e2e20000-0000-4000-8000-000000000007', 'e2e10000-0000-4000-8000-000000000003',
   'Le jeûne : piliers, dispenses et rattrapage', 'le-jeune-piliers-dispenses-et-rattrapage', 'video', 1, 3120, false),
  ('e2e20000-0000-4000-8000-000000000008', 'e2e10000-0000-4000-8000-000000000003',
   'La zakat : biens concernés et bénéficiaires', 'la-zakat-biens-concernes-et-beneficiaires', 'video', 2, 2640, false),
  ('e2e20000-0000-4000-8000-000000000009', 'e2e10000-0000-4000-8000-000000000003',
   'Le Hajj et la ‘Umra étape par étape', 'le-hajj-et-la-umra-etape-par-etape', 'video', 3, 4080, false)
on conflict (id) do nothing;

-- The gated half. One preview row and one member row: the REST test in
-- member-gate.spec.ts asserts anon sees no more rows than there are previews.
insert into public.lesson_content (lesson_id, content, video_provider, video_id) values
  ('e2e20000-0000-4000-8000-000000000001',
   'Aperçu gratuit : les catégories d''eau et ce qui les rend pures.', 'none', null),
  ('e2e20000-0000-4000-8000-000000000002',
   'Contenu réservé aux membres : les conditions des ablutions.', 'none', null)
on conflict (lesson_id) do nothing;

-- --- prices, so the JSON-LD offer and the enrolment card have something -----

insert into public.products
  (kind, course_id, delivery, time_slot, schedule_label, hours_per_year,
   hours_per_week, language, price_cents, duration_days, status, display_order)
select
  'module', c.id, d.delivery, 'semaine-soir', 'Vendredi 19h00 – 21h00', 90, 30, 'fr',
  30000, 365, 'published', c.display_order
from public.courses c
cross join (values ('presentiel'::public.delivery_mode), ('online'::public.delivery_mode)) as d (delivery)
where c.id in (
  'e2e00000-0000-4000-8000-000000000001',
  'e2e00000-0000-4000-8000-000000000002',
  'e2e00000-0000-4000-8000-000000000003',
  'e2e00000-0000-4000-8000-000000000004',
  'e2e00000-0000-4000-8000-000000000005'
)
on conflict do nothing;

-- --- the two ways through the school, so step one of checkout has options ---

insert into public.cursus
  (id, slug, kind, title, subtitle, description, year_count, status, display_order)
values
  ('e2e30000-0000-4000-8000-000000000001', 'e2e-cursus-de-base', 'module',
   'Cursus de Base', 'Les matières à la carte, pour un an',
   'Vous choisissez les matières qui vous intéressent et vous les suivez pendant 365 jours.',
   1, 'published', 3),
  ('e2e30000-0000-4000-8000-000000000002', 'e2e-cursus-approfondi', 'approfondi',
   'Cursus Approfondi', 'Formation sur quatre ans',
   'Deux matières par an, pour approfondir les connaissances.',
   4, 'published', 4),
  ('e2e30000-0000-4000-8000-000000000003', 'e2e-cursus-approfondi-ados', 'approfondi',
   'Cursus Approfondi pour ados', 'Formation sur trois ans',
   'Le même enseignement, au rythme et aux matières adaptés aux plus jeunes.',
   3, 'published', 5)
on conflict (id) do nothing;

-- --- the programme year one of the Approfondi, for the cursus step ----------

insert into public.cursus_courses (cursus_id, course_id, delivery, year_index, position)
select 'e2e30000-0000-4000-8000-000000000002', c.id, d.delivery, 1, c.display_order
from public.courses c
cross join (values ('presentiel'::public.delivery_mode), ('online'::public.delivery_mode)) as d (delivery)
where c.id in (
  'e2e00000-0000-4000-8000-000000000001',
  'e2e00000-0000-4000-8000-000000000002'
)
on conflict do nothing;

-- The same module in a second programme, so the checkout has a choice to ask
-- about. `sciences-du-coran` stays in one programme only, which is the other
-- half of the rule: a single programme must not show the choice step.
insert into public.cursus_courses (cursus_id, course_id, delivery, year_index, position)
select 'e2e30000-0000-4000-8000-000000000003', c.id, d.delivery, 1, c.display_order
from public.courses c
cross join (values ('presentiel'::public.delivery_mode), ('online'::public.delivery_mode)) as d (delivery)
where c.id = 'e2e00000-0000-4000-8000-000000000001'
on conflict do nothing;
