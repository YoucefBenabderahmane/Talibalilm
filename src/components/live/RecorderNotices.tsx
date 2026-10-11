'use client';

import { AlertTriangle, Download, Trash2, X } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import type { StoredRecording } from '@/lib/live/recording/chunk-store';
import type { RecorderIssue } from './useRecorder';
import { safeLocale } from '@/i18n/routing';

/**
 * What the recorder has to tell the teacher, in the room, at the moment it
 * happens — never a log nobody reads.
 *
 * The sentence is our reading of the problem; `detail` is the browser's own
 * words, shown under it (CLAUDE.md: the evidence wins). Only the host ever
 * sees this: the recorder is a teacher's tool, and the teacher is staff.
 */
export function RecorderNotices({
  issue,
  warnings,
  part,
  recovered,
  onDismiss,
  onDownloadRecovered,
  onDiscardRecovered,
}: {
  issue: RecorderIssue | null;
  warnings: RecorderIssue[];
  part: number;
  recovered: StoredRecording[];
  onDismiss: () => void;
  onDownloadRecovered: (id: string) => void;
  onDiscardRecovered: (id: string) => void;
}) {
  const t = useTranslations('live');
  const locale = safeLocale(useLocale());
  if (!issue && warnings.length === 0 && recovered.length === 0) return null;

  const size = (bytes: number) =>
    new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(bytes / 1_000_000) + ' Mo';
  const when = (ms: number) =>
    new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' }).format(ms);

  return (
    <div className="flex shrink-0 flex-col gap-2 border-b border-white/10 px-4 py-2 text-[12px]">
      {issue && (
        <div role="alert" className="flex items-start gap-2 rounded-lg bg-red-500/15 p-2.5 text-red-100">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-red-300" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p>{t(`recordIssue.${issue.code}`, { part })}</p>
            {issue.detail && (
              <p className="mt-1 font-mono text-[11px] break-words text-red-200/70">{issue.detail}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onDismiss}
            className="rounded p-1 text-red-200/70 hover:text-white"
            aria-label={t('dismiss')}
          >
            <X className="size-3.5" aria-hidden="true" />
          </button>
        </div>
      )}

      {warnings.map((warning) => (
        <div
          key={warning.code}
          role="status"
          className="flex items-start gap-2 rounded-lg bg-gold-500/10 p-2.5 text-gold-100"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-gold-300" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p>{t(`recordIssue.${warning.code}`, { part })}</p>
            {warning.detail && (
              <p className="mt-1 font-mono text-[11px] break-words text-gold-200/60">
                {warning.detail}
              </p>
            )}
          </div>
        </div>
      ))}

      {recovered.map((recording) => (
        <div
          key={recording.id}
          role="status"
          className="flex flex-wrap items-center gap-2 rounded-lg bg-white/5 p-2.5 text-white/80"
        >
          <p className="min-w-0 flex-1">
            {t('recordRecovered', {
              size: size(recording.bytes),
              date: when(recording.startedAt),
            })}
          </p>
          <button
            type="button"
            onClick={() => onDownloadRecovered(recording.id)}
            className="inline-flex items-center gap-1.5 rounded-full bg-brand-500 px-3 py-1.5 text-white hover:bg-brand-600"
          >
            <Download className="size-3.5" aria-hidden="true" />
            {t('recordRecoveredDownload')}
          </button>
          <button
            type="button"
            onClick={() => {
              if (window.confirm(t('recordRecoveredDiscardConfirm'))) onDiscardRecovered(recording.id);
            }}
            className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 hover:bg-white/20"
          >
            <Trash2 className="size-3.5" aria-hidden="true" />
            {t('recordRecoveredDiscard')}
          </button>
        </div>
      ))}
    </div>
  );
}
