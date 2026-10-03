'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { ActionForm } from '@/components/ui/action-form';
import { SaveButton } from '@/components/admin/SaveButton';
import { ActionError } from '@/components/admin/ActionError';
import {
  createClass,
  deleteClass,
  removeClassMember,
  updateClass,
} from '@/app/actions/classes';
import type { AdminState } from '@/app/actions/admin';
import type { ClassWithMembers } from '@/lib/data/classes';

const IDLE: AdminState = { ok: false };

const FIELD =
  'w-full rounded-[var(--radius-input)] border border-line bg-white px-4 py-3 text-sm text-ink outline-none focus:border-brand-400';

/**
 * The module's classes, on the module's own screen.
 *
 * The office names the groups and writes their timetable; the students join
 * one themselves from the module's public page. A class that already has a
 * live session cannot be deleted — the database refuses and the refusal is
 * shown here, which is the honest answer rather than a class that disappears
 * from under its own history.
 */
export function ClassManager({
  courseId,
  classes,
}: {
  courseId: string;
  classes: ClassWithMembers[];
}) {
  const t = useTranslations('admin');
  const [state, action] = useActionState(createClass, IDLE);

  return (
    <div className="max-w-3xl space-y-6">
      <p className="text-[13px] leading-relaxed text-ink-muted">{t('classesLead')}</p>

      <ActionForm
        action={action}
        className="space-y-4 rounded-[var(--radius-card)] border border-line bg-white p-5"
      >
        <input type="hidden" name="courseId" value={courseId} />
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1.5 block text-[13px] font-medium text-ink">{t('className')}</span>
            <input name="name" required maxLength={120} className={FIELD} />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-[13px] font-medium text-ink">
              {t('classSchedule')}
            </span>
            <input name="schedule" maxLength={200} className={FIELD} />
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <SaveButton state={state} label={t('classCreate')} size="sm" />
          <ActionError state={state} />
        </div>
      </ActionForm>

      {classes.length === 0 ? (
        <p className="rounded-[var(--radius-card)] border border-dashed border-line bg-surface/50 p-6 text-center text-sm text-ink-muted">
          {t('classesNone')}
        </p>
      ) : (
        <ul className="space-y-4">
          {classes.map((klass) => (
            <ClassRow key={klass.id} klass={klass} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ClassRow({ klass }: { klass: ClassWithMembers }) {
  const t = useTranslations('admin');
  const [updateState, updateAction] = useActionState(updateClass, IDLE);
  const [deleteState, deleteAction] = useActionState(deleteClass, IDLE);
  const [memberState, memberAction] = useActionState(removeClassMember, IDLE);

  return (
    <li className="rounded-[var(--radius-card)] border border-line bg-white p-5">
      <ActionForm action={updateAction} className="space-y-4">
        <input type="hidden" name="id" value={klass.id} />
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1.5 block text-[13px] font-medium text-ink">{t('className')}</span>
            <input name="name" required maxLength={120} defaultValue={klass.name} className={FIELD} />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-[13px] font-medium text-ink">
              {t('classSchedule')}
            </span>
            <input
              name="schedule"
              maxLength={200}
              defaultValue={klass.schedule}
              className={FIELD}
            />
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <SaveButton state={updateState} label={t('classSave')} size="sm" />
          <ActionError state={updateState} />
        </div>
      </ActionForm>

      <div className="mt-5 border-t border-line pt-4">
        <p className="text-[11px] font-semibold tracking-[0.1em] text-ink-muted uppercase">
          {t('classMembers', { count: klass.members.length })}
        </p>

        {klass.members.length === 0 ? (
          <p className="mt-2 text-[12px] text-ink-muted">{t('classNoMembers')}</p>
        ) : (
          <ul className="mt-3 flex flex-wrap gap-2">
            {klass.members.map((member) => (
              <li key={member.id}>
                <ActionForm action={memberAction} className="inline-flex">
                  <input type="hidden" name="classId" value={klass.id} />
                  <input type="hidden" name="userId" value={member.id} />
                  <span className="inline-flex items-center gap-2 rounded-full border border-line bg-surface/50 py-1 ps-3 pe-1 text-[12px] text-ink">
                    {member.name || member.id.slice(0, 8)}
                    <SaveButton
                      state={memberState}
                      label={t('classRemoveMember')}
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-[11px]"
                    />
                  </span>
                </ActionForm>
              </li>
            ))}
          </ul>
        )}
        <ActionError state={memberState} />
      </div>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
        <ActionForm action={deleteAction} className="flex items-center gap-3">
          <input type="hidden" name="id" value={klass.id} />
          <SaveButton state={deleteState} label={t('classDelete')} variant="outline" size="sm" />
          <ActionError state={deleteState} />
        </ActionForm>
      </div>
    </li>
  );
}
