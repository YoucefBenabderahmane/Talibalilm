'use client';

import { useState, type MouseEvent } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { CheckCircle2, MonitorUp } from 'lucide-react';
import { createLocalScreenTracks, Track } from 'livekit-client';
import { Button } from '@/components/ui/button';
import { SCREEN_CAPTURE } from '@/lib/live/media';
import { classifyShareError, seconds, shareSteps } from '@/lib/live/share-timeline';

type Result =
  | {
      kind: 'ok';
      page: string | null;
      chrome: string | null;
      width?: number;
      height?: number;
      fps?: number;
      surface: string;
    }
  | { kind: 'cancelled' }
  | { kind: 'refused' | 'failed'; detail: string };

const SURFACES = new Set(['monitor', 'window', 'browser']);

/**
 * Chrome's « choose what to share » window, opened outside the class.
 *
 * A teacher waited over two minutes for that window inside a class, while the
 * room's own code was measured asking Chrome for it in under a quarter of a
 * second. This tells the two apart on her own machine: run it in another tab
 * during a class. Quick here and slow in the class means the class; slow here
 * too means Chrome or Windows.
 *
 * The request is the room's own (LiveKit's createLocalScreenTracks with the
 * room's capture options), so the comparison is fair. Nothing is published:
 * the capture is stopped as soon as it is measured.
 */
export function ScreenShareCheck() {
  const t = useTranslations('admin');
  const locale = useLocale();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  const run = async (event: MouseEvent) => {
    const clicked = event.timeStamp;
    const handled = performance.now();
    setBusy(true);
    setResult(null);
    const requested = performance.now();
    try {
      const tracks = await createLocalScreenTracks(SCREEN_CAPTURE);
      const chosen = performance.now();
      const video = tracks.find((track) => track.kind === Track.Kind.Video);
      const settings = video?.mediaStreamTrack.getSettings() ?? {};
      for (const track of tracks) track.stop();
      const steps = shareSteps({
        clicked,
        handled,
        requested,
        chosen,
        published: null,
        received: null,
      });
      const surface = String((settings as { displaySurface?: string }).displaySurface ?? 'unknown');
      setResult({
        kind: 'ok',
        page: seconds(steps.page, locale),
        chrome: seconds(steps.chrome, locale),
        width: settings.width,
        height: settings.height,
        fps: settings.frameRate ? Math.round(settings.frameRate) : undefined,
        surface: SURFACES.has(surface) ? surface : 'unknown',
      });
    } catch (error) {
      const { outcome, detail } = classifyShareError(error);
      setResult(outcome === 'cancelled' ? { kind: 'cancelled' } : { kind: outcome, detail });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="mt-10 rounded-[var(--radius-card)] border border-line bg-white p-4"
      data-testid="share-test"
    >
      <p className="text-[13px] font-medium text-ink">{t('shareTestTitle')}</p>
      <p className="mt-1 max-w-2xl text-[12px] leading-relaxed text-ink-muted">
        {t('shareTestLead')}
      </p>

      <Button
        type="button"
        size="sm"
        variant="outline"
        className="mt-3"
        disabled={busy}
        onClick={(event) => void run(event)}
      >
        <MonitorUp className="size-3.5" aria-hidden="true" />
        {busy ? t('shareTestRunning') : t('shareTestButton')}
      </Button>

      {result?.kind === 'ok' && (
        <div role="status" className="mt-3 flex items-start gap-2 text-[12px] text-brand-700">
          <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <div className="tabular-nums">
            <p data-testid="share-test-result">
              {t('shareTestResult', { page: result.page ?? '–', chrome: result.chrome ?? '–' })}
            </p>
            {result.width && result.height && (
              <p className="mt-0.5 text-ink-muted">
                {t('shareTestCapture', {
                  width: result.width,
                  height: result.height,
                  fps: result.fps ?? '–',
                  surface: t(`shareTestSurface.${result.surface}` as 'shareTestSurface.unknown'),
                })}
              </p>
            )}
          </div>
        </div>
      )}
      {result?.kind === 'cancelled' && (
        <p role="status" className="mt-3 text-[12px] text-ink-muted">
          {t('shareTestCancelled')}
        </p>
      )}
      {(result?.kind === 'refused' || result?.kind === 'failed') && (
        <div className="mt-3">
          <p role="alert" className="text-[12px] text-red-600">
            {t(result.kind === 'refused' ? 'shareTestRefused' : 'shareTestFailed')}
          </p>
          {/* The browser's own words: this page is for staff, who can act on them. */}
          <pre className="mt-2 overflow-x-auto rounded-[var(--radius-input)] border border-red-200 bg-red-50/60 p-3 text-[11px] leading-relaxed break-words whitespace-pre-wrap text-red-900">
            {result.detail}
          </pre>
        </div>
      )}
    </section>
  );
}
