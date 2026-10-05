'use client';

import { useTranslations } from 'next-intl';
import {
  Circle,
  Hand,
  Loader2,
  LogOut,
  Mic,
  MicOff,
  MonitorUp,
  MonitorX,
  PauseCircle,
  PlayCircle,
  Square,
  Video,
  VideoOff,
} from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * The bar along the bottom.
 *
 * What appears here is decided by what the server granted, not by role alone: a
 * student allowed a camera by the teacher sees a camera button, and a student
 * who is not does not. A disabled button that says "ask your teacher" would be
 * honest but useless; an absent one is honest and quiet.
 *
 * Ending the class is the teacher's, and it is not next to Leave — those two
 * being adjacent is how a teacher ends a lesson for forty people by accident.
 */
export function Controls({
  isHost,
  micOn,
  camOn,
  sharing,
  handUp,
  canMic,
  canCam,
  canShare,
  recording,
  onMic,
  onCam,
  onShare,
  onHand,
  onAskCamera,
  onAskScreen,
  onRecord,
  onPauseRecord,
  onLeave,
  onEnd,
}: {
  isHost: boolean;
  micOn: boolean;
  camOn: boolean;
  sharing: boolean;
  handUp: boolean;
  canMic: boolean;
  canCam: boolean;
  canShare: boolean;
  recording: 'idle' | 'starting' | 'recording' | 'paused' | 'saving';
  onMic: () => void;
  onCam: () => void;
  onShare: () => void;
  onHand: () => void;
  onAskCamera: () => void;
  onAskScreen: () => void;
  onRecord: () => void;
  onPauseRecord: () => void;
  onLeave: () => void;
  onEnd: () => void;
}) {
  const t = useTranslations('live');

  const base =
    'inline-flex items-center gap-2 rounded-full px-4 py-2.5 text-[13px] font-medium transition-colors disabled:opacity-40';
  const quiet = 'bg-white/10 text-white hover:bg-white/20';
  const danger = 'bg-red-600 text-white hover:bg-red-700';

  return (
    <div className="flex flex-wrap items-center justify-center gap-2 border-t border-white/10 bg-ink/90 px-3 py-3">
      {canMic && (
        <button type="button" onClick={onMic} className={cn(base, micOn ? quiet : danger)}>
          {micOn ? (
            <Mic className="size-4" aria-hidden="true" />
          ) : (
            <MicOff className="size-4" aria-hidden="true" />
          )}
          <span className="hidden sm:inline">{micOn ? t('micOn') : t('micOff')}</span>
        </button>
      )}

      {canCam ? (
        <button
          type="button"
          onClick={onCam}
          className={cn(base, camOn ? quiet : 'bg-white/10 text-white/70 hover:bg-white/20')}
        >
          {camOn ? (
            <Video className="size-4" aria-hidden="true" />
          ) : (
            <VideoOff className="size-4" aria-hidden="true" />
          )}
          <span className="hidden sm:inline">{camOn ? t('camOn') : t('camOff')}</span>
        </button>
      ) : (
        !isHost && (
          <button type="button" onClick={onAskCamera} className={cn(base, quiet)}>
            <Video className="size-4" aria-hidden="true" />
            <span className="hidden sm:inline">{t('askCamera')}</span>
          </button>
        )
      )}

      {canShare ? (
        <button
          type="button"
          onClick={onShare}
          className={cn(base, sharing ? 'bg-brand-500 text-white' : quiet)}
        >
          {sharing ? (
            <MonitorX className="size-4" aria-hidden="true" />
          ) : (
            <MonitorUp className="size-4" aria-hidden="true" />
          )}
          <span className="hidden sm:inline">{sharing ? t('stopShare') : t('share')}</span>
        </button>
      ) : (
        !isHost && (
          <button type="button" onClick={onAskScreen} className={cn(base, quiet)}>
            <MonitorUp className="size-4" aria-hidden="true" />
            <span className="hidden sm:inline">{t('askScreen')}</span>
          </button>
        )
      )}

      {!isHost && (
        <button
          type="button"
          onClick={onHand}
          aria-pressed={handUp}
          className={cn(base, handUp ? 'bg-gold-500 text-ink' : quiet)}
        >
          <Hand className="size-4" aria-hidden="true" />
          <span className="hidden sm:inline">{handUp ? t('handDown') : t('handUp')}</span>
        </button>
      )}

      {isHost && (
        <>
          <span className="mx-1 hidden h-6 w-px bg-white/15 sm:block" aria-hidden="true" />

          {recording === 'idle' || recording === 'saving' || recording === 'starting' ? (
            <button
              type="button"
              onClick={onRecord}
              disabled={recording !== 'idle'}
              className={cn(base, quiet)}
            >
              {recording === 'idle' ? (
                <Circle className="size-3.5 fill-red-500 text-red-500" aria-hidden="true" />
              ) : (
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              )}
              <span className="hidden sm:inline">
                {recording === 'saving'
                  ? t('saving')
                  : recording === 'starting'
                    ? t('startingRecording')
                    : t('startRecording')}
              </span>
            </button>
          ) : (
            <>
              <button type="button" onClick={onPauseRecord} className={cn(base, quiet)}>
                {recording === 'paused' ? (
                  <PlayCircle className="size-4" aria-hidden="true" />
                ) : (
                  <PauseCircle className="size-4" aria-hidden="true" />
                )}
                <span className="hidden sm:inline">
                  {recording === 'paused' ? t('resumeRecording') : t('pauseRecording')}
                </span>
              </button>
              <button type="button" onClick={onRecord} className={cn(base, danger)}>
                <Square className="size-3.5 fill-current" aria-hidden="true" />
                <span className="hidden sm:inline">{t('stopRecording')}</span>
              </button>
            </>
          )}
        </>
      )}

      <span className="mx-1 hidden h-6 w-px bg-white/15 sm:block" aria-hidden="true" />

      <button type="button" onClick={onLeave} className={cn(base, quiet)}>
        <LogOut className="size-4" aria-hidden="true" />
        <span className="hidden sm:inline">{t('leave')}</span>
      </button>

      {isHost && (
        <button
          type="button"
          onClick={onEnd}
          className={cn(
            base,
            'border border-red-500/40 bg-transparent text-red-300 hover:bg-red-600 hover:text-white',
          )}
        >
          {t('endForAll')}
        </button>
      )}
    </div>
  );
}
