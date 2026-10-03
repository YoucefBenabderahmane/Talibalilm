'use client';

import { useActionState, useRef, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, ChevronUp, GripVertical, Loader2, Plus, Trash2, Wand2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Field } from '@/components/ui/field';
import { LessonVideoUpload } from '@/components/admin/LessonVideoUpload';
import { fillLessonFromVideo } from '@/app/actions/admin';
import {
  addLesson,
  addModule,
  deleteLesson,
  deleteModule,
  moveLesson,
  moveModule,
  renameModule,
  updateLesson,
  type AdminState,
} from '@/app/actions/admin';
import { SaveButton } from '@/components/admin/SaveButton';
import { cn } from '@/lib/utils';
import { ActionForm } from '@/components/ui/action-form';

const IDLE: AdminState = { ok: false };

export interface OutlineLesson {
  id: string;
  title: string;
  type: string;
  position: number;
  minutes: number;
  isPreview: boolean;
  content: string;
  videoId: string;
  videoProvider: string;
  videoBytes: number;
  videoExpiresAt: string | null;
}

export interface OutlineModule {
  id: string;
  title: string;
  position: number;
  lessons: OutlineLesson[];
}

/**
 * Modules and lessons, with reordering.
 *
 * Reordering is up/down buttons rather than drag-and-drop. That is a
 * deliberate trade: buttons are keyboard-operable and screen-reader-legible
 * for free, they work on touch without a long-press gesture, and each press is
 * one swap the database can validate. Drag-and-drop is the nicer gesture for a
 * sighted mouse user and is worth adding on top — but not instead.
 */
export function CourseOutline({
  courseId,
  modules,
}: {
  courseId: string;
  modules: OutlineModule[];
}) {
  const t = useTranslations('admin');
  const [addState, addModuleAction] = useActionState(addModule, IDLE);

  return (
    <div>
      <ol className="space-y-4">
        {modules.map((module, index) => (
          <ModuleCard
            key={module.id}
            module={module}
            previous={index > 0 ? modules[index - 1] : undefined}
            next={index < modules.length - 1 ? modules[index + 1] : undefined}
          />
        ))}
      </ol>

      <ActionForm
        action={addModuleAction}
        className="mt-4 flex flex-wrap items-end gap-3 rounded-[var(--radius-card)] border border-dashed border-line bg-surface/40 p-4"
      >
        <input type="hidden" name="courseId" value={courseId} />
        <Field label={t('moduleTitle')} name="title" required className="min-w-[220px] flex-1" />
        <SaveButton
          state={addState}
          label={t('addModule')}
          variant="outline"
          size="md"
          icon={<Plus aria-hidden="true" />}
        />
      </ActionForm>
    </div>
  );
}

function ModuleCard({
  module,
  previous,
  next,
}: {
  module: OutlineModule;
  previous: OutlineModule | undefined;
  next: OutlineModule | undefined;
}) {
  const t = useTranslations('admin');
  const [renameState, renameAction] = useActionState(renameModule, IDLE);
  const [, deleteAction] = useActionState(deleteModule, IDLE);
  const [, moveAction] = useActionState(moveModule, IDLE);
  const [addLessonState, addLessonAction] = useActionState(addLesson, IDLE);

  return (
    <li className="rounded-[var(--radius-card)] border border-line bg-white">
      <div className="flex flex-wrap items-center gap-2 border-b border-line p-4">
        <GripVertical className="size-4 shrink-0 text-ink-muted/40" aria-hidden="true" />

        <ActionForm action={renameAction} className="flex min-w-[200px] flex-1 items-center gap-2">
          <input type="hidden" name="id" value={module.id} />
          <input
            name="title"
            defaultValue={module.title}
            aria-label={t('moduleTitle')}
            className="min-w-0 flex-1 rounded-[var(--radius-input)] border border-transparent bg-transparent px-2 py-1.5 font-display text-[15px] font-semibold text-ink transition-colors hover:border-line focus:border-brand-400 focus:outline-none"
          />
          <SaveButton state={renameState} label={t('save')} size="sm" variant="ghost" />
        </ActionForm>

        <MoveButtons formAction={moveAction} item={module} previous={previous} next={next} />

        <ActionForm
          action={deleteAction}
          onSubmit={(event) => {
            if (!window.confirm(t('confirmDelete'))) event.preventDefault();
          }}
        >
          <input type="hidden" name="id" value={module.id} />
          <Button type="submit" size="sm" variant="ghost" aria-label={t('delete')}>
            <Trash2 className="size-3.5" aria-hidden="true" />
          </Button>
        </ActionForm>
      </div>

      <ul className="divide-y divide-line">
        {module.lessons.map((lesson, index) => (
          <LessonRow
            key={lesson.id}
            lesson={lesson}
            previous={index > 0 ? module.lessons[index - 1] : undefined}
            next={index < module.lessons.length - 1 ? module.lessons[index + 1] : undefined}
          />
        ))}
      </ul>

      <ActionForm action={addLessonAction} className="flex flex-wrap items-end gap-3 p-4">
        <input type="hidden" name="moduleId" value={module.id} />
        <Field label={t('lessonTitle')} name="title" required className="min-w-[200px] flex-1" />
        <SaveButton
          state={addLessonState}
          label={t('addLesson')}
          size="sm"
          variant="outline"
          icon={<Plus aria-hidden="true" />}
        />
      </ActionForm>
    </li>
  );
}

function LessonRow({
  lesson,
  previous,
  next,
}: {
  lesson: OutlineLesson;
  previous: OutlineLesson | undefined;
  next: OutlineLesson | undefined;
}) {
  const t = useTranslations('admin');
  const [open, setOpen] = useState(false);
  const [state, updateAction] = useActionState(updateLesson, IDLE);
  const formRef = useRef<HTMLFormElement>(null);
  const [filling, startFill] = useTransition();
  const [fillNote, setFillNote] = useState<string | null>(null);

  /**
   * "Remplir": read the video link in the form, ask the video what it is, and
   * write the title, the type and a content line into the fields. Nothing is
   * saved — the office reviews it and presses save.
   */
  const fill = () => {
    const form = formRef.current;
    if (!form) return;
    const link = (form.elements.namedItem('video_id') as HTMLInputElement | null)?.value ?? '';
    setFillNote(null);

    startFill(async () => {
      const result = await fillLessonFromVideo(link);
      if (!result.ok) {
        setFillNote(t('errors.videoUnrecognised'));
        return;
      }

      const set = (name: string, value: string) => {
        const field = form.elements.namedItem(name) as HTMLInputElement | null;
        if (field && value) field.value = value;
      };
      if (result.title) set('title', result.title);
      if (result.content) set('content', result.content);
      if (result.videoId) set('video_id', result.videoId);
      set('type', 'video');
      setFillNote(t('lessonFilled'));
    });
  };
  const [, deleteAction] = useActionState(deleteLesson, IDLE);
  const [, moveAction] = useActionState(moveLesson, IDLE);

  return (
    <li className="p-4">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="min-w-0 flex-1 text-start text-[13px] text-ink transition-colors hover:text-brand-600"
        >
          <span className="line-clamp-1">{lesson.title}</span>
          <span className="text-[11px] text-ink-muted">
            {lesson.type} · {lesson.minutes} min
          </span>
        </button>

        {/* On the row, before the details are open: the office asked for the
            way in to be visible rather than hidden behind the title, and for
            this button to be what opens the lesson. Once it is open, the same
            action lives beside the title field and this one steps aside. */}
        {!open && (
          <Button
            type="button"
            size="sm"
            variant="goldOutline"
            onClick={() => setOpen(true)}
            title={t('lessonFill')}
          >
            <Wand2 className="size-3.5" aria-hidden="true" />
            {t('lessonFill')}
          </Button>
        )}

        {lesson.isPreview && <Badge variant="gold">{t('isPreview')}</Badge>}

        <MoveButtons formAction={moveAction} item={lesson} previous={previous} next={next} />

        <ActionForm
          action={deleteAction}
          onSubmit={(event) => {
            if (!window.confirm(t('confirmDelete'))) event.preventDefault();
          }}
        >
          <input type="hidden" name="id" value={lesson.id} />
          <Button type="submit" size="sm" variant="ghost" aria-label={t('delete')}>
            <Trash2 className="size-3.5" aria-hidden="true" />
          </Button>
        </ActionForm>
      </div>

      {open && (
        <ActionForm
          ref={formRef}
          action={updateAction}
          className="mt-4 space-y-3 rounded-[var(--radius-input)] bg-surface/50 p-4"
        >
          <input type="hidden" name="id" value={lesson.id} />

          {/* The title is the first thing read and the first thing filled, so
              it is bigger than the rest of the form and carries the one button
              that can write it for you. */}
          <div className="flex flex-wrap items-end gap-2">
            <label className="block min-w-[220px] flex-1">
              <span className="mb-1.5 block text-[13px] font-medium text-ink">
                {t('lessonTitle')}
              </span>
              <input
                name="title"
                defaultValue={lesson.title}
                required
                maxLength={200}
                className="w-full rounded-[var(--radius-input)] border border-line bg-white px-4 py-3 font-display text-[17px] font-medium text-ink outline-none focus:border-brand-400"
              />
            </label>
            <Button
              type="button"
              size="md"
              variant="goldOutline"
              disabled={filling}
              onClick={() => void fill()}
            >
              {filling ? <Loader2 className="size-4 animate-spin" /> : <Wand2 className="size-4" />}
              {t('lessonFill')}
            </Button>
          </div>

          {fillNote && (
            <p role="status" className="text-[12px] text-ink-muted">
              {fillNote}
            </p>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1.5 block text-[13px] font-medium text-ink">
                {t('lessonType')}
              </span>
              <select
                name="type"
                defaultValue={lesson.type}
                className="w-full rounded-[var(--radius-input)] border border-line bg-white px-3 py-2.5 text-sm text-ink outline-none focus:border-brand-400"
              >
                {['video', 'text', 'live', 'quiz', 'assignment'].map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <Field
              label={t('duration')}
              name="minutes"
              type="number"
              min={0}
              defaultValue={lesson.minutes}
            />
            <Field
              label={t('videoId')}
              name="video_id"
              defaultValue={lesson.videoProvider === 'r2' ? '' : lesson.videoId}
              hint={
                lesson.videoProvider === 'r2' ? t('videoIdUploadedHint') : t('videoIdHint')
              }
              error={
                state.error === 'video_unrecognised' || state.error === 'video_id_is_url'
                  ? t('videoUnrecognised')
                  : undefined
              }
            />
          </div>

          {/*
            The other way to give a lesson a video. Outside the form on
            purpose: it uploads and saves on its own, so putting it inside
            would make a half-finished upload part of whatever else the
            teacher happens to be editing.
          */}
          <LessonVideoUpload
            lessonId={lesson.id}
            provider={lesson.videoProvider}
            bytes={lesson.videoBytes}
            expiresAt={lesson.videoExpiresAt}
          />

          <label className="block">
            <span className="mb-1.5 block text-[13px] font-medium text-ink">{t('content')}</span>
            <textarea
              name="content"
              rows={8}
              defaultValue={lesson.content}
              className="w-full rounded-[var(--radius-input)] border border-line bg-white px-4 py-3 text-sm text-ink outline-none focus:border-brand-400"
            />
          </label>

          <label className="flex items-center gap-2.5 text-[13px] text-ink">
            <input
              type="checkbox"
              name="is_preview"
              defaultChecked={lesson.isPreview}
              className="size-4 rounded border-line text-brand-500"
            />
            {t('isPreview')}
          </label>

          <SaveButton state={state} label={t('save')} size="sm" />
        </ActionForm>
      )}
    </li>
  );
}

/** Swap this row with its neighbour. Renders nothing at the ends of a list. */
function MoveButtons<T extends { id: string; position: number }>({
  formAction,
  item,
  previous,
  next,
}: {
  formAction: (formData: FormData) => void;
  item: T;
  previous: T | undefined;
  next: T | undefined;
}) {
  const t = useTranslations('admin');

  return (
    <span className="inline-flex">
      {(
        [
          ['up', previous],
          ['down', next],
        ] as const
      ).map(([direction, neighbour]) => (
        <ActionForm key={direction} action={formAction}>
          <input type="hidden" name="id" value={item.id} />
          <input type="hidden" name="position" value={item.position} />
          <input type="hidden" name="otherId" value={neighbour?.id ?? ''} />
          <input type="hidden" name="otherPosition" value={neighbour?.position ?? ''} />
          <button
            type="submit"
            disabled={!neighbour}
            aria-label={direction === 'up' ? t('moveUp') : t('moveDown')}
            className={cn(
              'rounded-md p-1.5 transition-colors',
              neighbour
                ? 'text-ink-muted hover:bg-brand-50 hover:text-brand-600'
                : 'cursor-not-allowed text-ink-muted/25',
            )}
          >
            {direction === 'up' ? (
              <ChevronUp className="size-3.5" aria-hidden="true" />
            ) : (
              <ChevronDown className="size-3.5" aria-hidden="true" />
            )}
          </button>
        </ActionForm>
      ))}
    </span>
  );
}
