'use client';

import { useEffect } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { AlertTriangle, MonitorUp, X } from 'lucide-react';
import { seconds, shareSteps, slowestStep, type ShareSteps } from '@/lib/live/share-timeline';
import { cn } from '@/lib/utils';
import type { ShareReport } from './useRoom';

/** How long a share that started without a slow step stays on screen. */
const SHOWN_MS = 20_000;

const STEPS: (keyof ShareSteps)[] = ['page', 'site', 'chrome', 'send', 'receive'];

/**
 * How the last screen share went, for the person who shared.
 *
 * A share that would not start used to say nothing: the button stayed as it
 * was, and she clicked again and again. Now a refusal says so, with the
 * browser's own words for staff, and a share that started shows how long each
 * step took, so a slow start names the step that was slow: her tab, Chrome's
 * window, the upload, or the class. See lib/live/share-timeline.ts.
 *
 * Students who share get the sentence without the browser's detail, as
 * everywhere a student can reach.
 */
export function ShareNotice({
  report,
  staff,
  onDismiss,
}: {
  report: ShareReport | null;
  staff: boolean;
  onDismiss: () => void;
}) {
  const t = useTranslations('live');
  const locale = useLocale();
  const steps = report ? shareSteps(report.stamps) : null;
  const slow = steps ? slowestStep(steps) : null;
  const outcome = report?.outcome;

  // A quick start is shown briefly; a slow one stays until dismissed.
  useEffect(() => {
    if (outcome !== 'started' || slow) return;
    const id = window.setTimeout(onDismiss, SHOWN_MS);
    return () => window.clearTimeout(id);
  }, [outcome, slow, onDismiss]);

  if (!report || !steps || outcome === 'pending' || outcome === 'cancelled') return null;

  if (outcome === 'refused' || outcome === 'failed') {
    return (
      <div className="flex shrink-0 flex-col border-b border-room-line/70 px-4 py-2 text-[12px]">
        <div
          role="alert"
          data-share-notice={outcome}
          className="flex items-start gap-2 rounded-lg bg-red-500/15 p-2.5 text-red-100"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-red-300" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p>{t(outcome === 'refused' ? 'shareRefused' : 'shareFailed')}</p>
            {staff && report.detail && (
              <p className="mt-1 font-mono text-[11px] break-words text-red-200/70">
                {report.detail}
              </p>
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
      </div>
    );
  }

  if (!staff) return null;

  return (
    <div className="flex shrink-0 flex-col border-b border-room-line/70 px-4 py-2 text-[12px]">
      <div
        role="status"
        data-share-notice={slow ? 'slow' : 'started'}
        className={cn(
          'flex items-start gap-2 rounded-lg p-2.5',
          slow ? 'bg-gold-500/10 text-gold-100' : 'bg-white/5 text-white/80',
        )}
      >
        <MonitorUp
          className={cn('mt-0.5 size-4 shrink-0', slow ? 'text-gold-300' : 'text-room-green')}
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <p className="font-medium">{t('shareReportStarted')}</p>
          <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 tabular-nums">
            {STEPS.map((key) => {
              const value = seconds(steps[key], locale);
              if (value === null) return null;
              return (
                <li
                  key={key}
                  data-share-step={key}
                  className={cn(key === slow && 'font-semibold text-gold-200')}
                >
                  {t(`shareStep.${key}`, { s: value })}
                </li>
              );
            })}
          </ul>
          {slow && <p className="mt-1 text-gold-200/80">{t(`shareSlow.${slow}`)}</p>}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="rounded p-1 text-white/50 hover:text-white"
          aria-label={t('dismiss')}
        >
          <X className="size-3.5" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
