'use client';

import { useActionState, useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Field } from '@/components/ui/field';
import { SaveButton } from '@/components/admin/SaveButton';
import { updateCourse, type AdminState } from '@/app/actions/admin';
import { formatBullets, formatHighlights, type Highlight } from '@/lib/content/presentation';
import { ActionError } from '@/components/admin/ActionError';
import { ActionForm } from '@/components/ui/action-form';

const IDLE: AdminState = { ok: false };

const LEVELS = ['all', 'beginner', 'intermediate', 'advanced'] as const;
const FORMATS = ['presentiel', 'visio', 'hybride'] as const;

export interface CourseSettings {
  id: string;
  title: string;
  slug: string;
  subtitle: string;
  /** When the module is taught — shown on its public page, under the subtitle. */
  schedule: string;
  description: string;
  title_ar: string;
  level: string;
  format: string;
  duration_weeks: number;
  requirements: string[];
  highlights: Highlight[];
}

export function CourseSettingsForm({
  course,
  formId,
}: {
  course: CourseSettings;
  /** Set when the page's footer submits this form from another step. */
  formId?: string;
}) {
  const t = useTranslations('admin');
  const tc = useTranslations('courses');
  const [state, action] = useActionState(updateCourse, IDLE);
  const formRef = useRef<HTMLFormElement>(null);

  // A refusal used to say "invalid" and leave the office to guess which of a
  // dozen boxes it meant — and the reflex is to reload and start again, losing
  // everything typed. Nothing is cleared now (the action does not revalidate on
  // failure, so the DOM keeps what was entered); the cursor simply goes to the
  // field that was wrong.
  useEffect(() => {
    if (state.ok || !state.field) return;
    const target = formRef.current?.querySelector<HTMLElement>(`[name="${state.field}"]`);
    target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    target?.focus({ preventScroll: true });
  }, [state]);

  return (
    <ActionForm
      ref={formRef}
      id={formId}
      action={action}
      className="space-y-3 rounded-[var(--radius-card)] border border-line bg-white p-5"
    >
      <input type="hidden" name="id" value={course.id} />

      <Field label={t('courseTitle')} name="title" defaultValue={course.title} required />
      {/* Optional: plenty of modules have no Arabic name, and demanding one
          would make the office invent it. */}
      <Field
        label={`${t('titleAr')} ${t('optional')}`}
        name="title_ar"
        defaultValue={course.title_ar}
        dir="rtl"
      />
      <Field label={t('subtitle')} name="subtitle" defaultValue={course.subtitle} />

      {/* Under the subtitle, and shown under it on the public page: when the
          module is taught. Two lines are allowed for a module with two slots. */}
      <label className="block">
        <span className="mb-1.5 block text-[13px] font-medium text-ink">
          {t('moduleSchedule')}
        </span>
        <textarea
          name="schedule"
          rows={2}
          maxLength={200}
          defaultValue={course.schedule}
          className="w-full rounded-[var(--radius-input)] border border-line bg-white px-4 py-3 text-sm text-ink outline-none transition-colors focus:border-brand-400"
        />
        <span className="mt-1.5 block text-[11px] text-ink-muted">
          {t('moduleScheduleHint')}
        </span>
      </label>

      <label className="block">
        <span className="mb-1.5 block text-[13px] font-medium text-ink">{t('description')}</span>
        <textarea
          name="description"
          rows={5}
          defaultValue={course.description}
          className="w-full rounded-[var(--radius-input)] border border-line bg-white px-4 py-3 text-sm text-ink outline-none transition-colors focus:border-brand-400"
        />
      </label>

      <div className="grid gap-3 sm:grid-cols-2">
        <Select
          label={tc('filterLevel')}
          name="level"
          value={course.level}
          options={LEVELS.map((l) => [l, tc(`level.${l}`)])}
        />
        <Select
          label={tc('detail.facts.format')}
          name="format"
          value={course.format}
          options={FORMATS.map((f) => [f, tc(`format.${f}`)])}
        />
      </div>

      <Field
        label={tc('detail.facts.duration')}
        name="duration_weeks"
        type="number"
        min={0}
        defaultValue={course.duration_weeks}
      />

      {/* Everything below appears on the module's public page, in this order.
          Left empty, the section is simply not rendered — a module that has
          nothing extra to say does not show an empty heading. */}
      <fieldset className="space-y-3 border-t border-line pt-4">
        <legend className="text-[11px] tracking-[0.14em] text-ink-muted uppercase">
          {t('presentation')}
        </legend>

        <Area
          label={t('requirements')}
          name="requirements"
          rows={4}
          hint={t('requirementsHint')}
          defaultValue={formatBullets(course.requirements)}
        />
        <Area
          label={t('highlights')}
          name="highlights"
          rows={3}
          hint={t('highlightsHint')}
          defaultValue={formatHighlights(course.highlights)}
        />
      </fieldset>

      <ActionError state={state} />

      <SaveButton state={state} label={t('save')} size="md" />
    </ActionForm>
  );
}

function Select({
  label,
  name,
  value,
  options,
}: {
  label: string;
  name: string;
  value: string;
  options: [string, string][];
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[13px] font-medium text-ink">{label}</span>
      <select
        name={name}
        defaultValue={value}
        className="w-full rounded-[var(--radius-input)] border border-line bg-white px-3 py-2.5 text-sm text-ink outline-none transition-colors focus:border-brand-400"
      >
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}

/** A labelled textarea with an optional line of guidance under it. */
function Area({
  label,
  name,
  rows,
  hint,
  defaultValue,
}: {
  label: string;
  name: string;
  rows: number;
  hint?: string;
  defaultValue: string;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[13px] font-medium text-ink">{label}</span>
      <textarea
        name={name}
        rows={rows}
        defaultValue={defaultValue}
        className="w-full rounded-[var(--radius-input)] border border-line bg-white px-4 py-3 text-sm text-ink outline-none transition-colors focus:border-brand-400"
      />
      {hint && <span className="mt-1 block text-[11px] text-ink-muted">{hint}</span>}
    </label>
  );
}
