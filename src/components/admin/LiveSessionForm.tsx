'use client';

import { useActionState, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ActionError } from '@/components/admin/ActionError';
import { SaveButton } from '@/components/admin/SaveButton';
import { createLiveSession } from '@/app/actions/live';
import type { AdminState } from '@/app/actions/admin';
import { ActionForm } from '@/components/ui/action-form';

const IDLE: AdminState = { ok: false };

/**
 * Schedule a session against one class of one module.
 *
 * The class is what decides who may attend: a student sees the session only if
 * they are in that class and hold the module. The classes offered are the ones
 * belonging to the chosen course, so the office cannot file a class under the
 * wrong subject — and the database's composite foreign key refuses it even if
 * a hand-posted form tried.
 */
export function LiveSessionForm({
  courses,
  classes,
  fixedCourseId,
}: {
  courses: { id: string; title: string }[];
  classes: { id: string; courseId: string; name: string }[];
  fixedCourseId?: string;
}) {
  const t = useTranslations('admin');
  const [state, action] = useActionState(createLiveSession, IDLE);
  const [courseId, setCourseId] = useState(fixedCourseId ?? courses[0]?.id ?? '');

  const field =
    'w-full rounded-[var(--radius-input)] border border-line bg-white px-4 py-3 text-sm text-ink outline-none focus:border-brand-400';

  const courseClasses = classes.filter((klass) => klass.courseId === courseId);

  return (
    <ActionForm
      action={action}
      className="space-y-4 rounded-[var(--radius-card)] border border-line bg-white p-5"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {fixedCourseId ? (
          <input type="hidden" name="courseId" value={fixedCourseId} />
        ) : (
          <label className="block">
            <span className="mb-1.5 block text-[13px] font-medium text-ink">{t('liveCourse')}</span>
            <select
              name="courseId"
              required
              className={field}
              value={courseId}
              onChange={(event) => setCourseId(event.target.value)}
            >
              {courses.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="block">
          <span className="mb-1.5 block text-[13px] font-medium text-ink">
            {t('liveClassGroup')}
          </span>
          {/* Remounted when the course changes: a class from the previous
              course must not stay selected. */}
          <select key={courseId} name="classId" required className={field} defaultValue="">
            <option value="" disabled>
              {courseClasses.length === 0 ? t('liveClassGroupNone') : t('liveClassGroupChoose')}
            </option>
            {courseClasses.map((klass) => (
              <option key={klass.id} value={klass.id}>
                {klass.name}
              </option>
            ))}
          </select>
          {courseClasses.length === 0 && (
            <span className="mt-1.5 block text-[11px] leading-relaxed text-ink-muted">
              {t('liveClassGroupHint')}
            </span>
          )}
        </label>

        <label className="block">
          <span className="mb-1.5 block text-[13px] font-medium text-ink">
            {t('liveClassTitle')}
          </span>
          <input name="title" required maxLength={200} className={field} />
        </label>

        <label className="block">
          <span className="mb-1.5 block text-[13px] font-medium text-ink">{t('liveWhen')}</span>
          <input type="datetime-local" name="scheduledAt" className={field} />
        </label>

        <label className="block">
          <span className="mb-1.5 block text-[13px] font-medium text-ink">{t('liveCapacity')}</span>
          <input
            type="number"
            name="maxParticipants"
            min={2}
            max={500}
            defaultValue={50}
            className={field}
          />
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <SaveButton state={state} label={t('liveCreate')} size="sm" />
        <ActionError state={state} />
      </div>
    </ActionForm>
  );
}
