'use client';

import { useTranslations } from 'next-intl';
import { Hand, Mic, MicOff, MonitorUp, Presentation, UserMinus, UserPlus } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { RoomPerson } from './useRoom';

export type HostAction =
  | 'mute'
  | 'unmute'
  | 'allow-camera'
  | 'deny-camera'
  | 'allow-screen'
  | 'deny-screen'
  /** Unmute and allow the camera in one decision. */
  | 'allow-speak'
  | 'deny-speak'
  | 'remove';

/**
 * Who is here, and — for the teacher only — what to do about them.
 *
 * The control buttons are not rendered at all for a student. Not hidden with
 * CSS, not disabled: absent from their page, the same way the plugin this
 * replaces gated them in PHP. That matters because a disabled button still
 * tells a curious student what the form would have submitted.
 *
 * Raised hands float to the top. In a class of forty, the teacher should not
 * have to hunt for the one person waiting to speak.
 *
 * The removed are listed underneath: a ban is a decision that survives a
 * reload, so undoing it has to be possible from the same panel that made it.
 */
export function ParticipantsPanel({
  people,
  isHost,
  staged,
  removed,
  onAction,
  onStage,
  onRestore,
  onClearAsk,
}: {
  people: RoomPerson[];
  isHost: boolean;
  /** Identity of the student currently on the big stage, or null. */
  staged: string | null;
  /** Removed from the class and not back yet — from the attendance record. */
  removed: { userId: string; name: string }[];
  onAction: (identity: string, action: HostAction) => void;
  onStage: (identity: string | null) => void;
  onRestore: (userId: string) => void;
  onClearAsk: (identity: string) => void;
}) {
  const t = useTranslations('live');

  const sorted = [...people].sort((a, b) => {
    if (a.isHost !== b.isHost) return a.isHost ? -1 : 1;
    if (Boolean(a.asking) !== Boolean(b.asking)) return a.asking ? -1 : 1;
    if (a.handUp !== b.handUp) return a.handUp ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const icon = 'inline-flex size-7 items-center justify-center rounded-lg transition-colors';

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ul className="min-h-0 flex-1 divide-y divide-white/5 overflow-y-auto">
        {sorted.map((person) => (
          <li key={person.identity} className="p-3">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-[13px] text-white">
                {person.name}
                {person.isLocal && <span className="text-white/40"> · {t('you')}</span>}
              </span>

              {person.handUp && (
                <Hand className="size-3.5 shrink-0 text-gold-400" aria-hidden="true" />
              )}
              {person.sharing && (
                <MonitorUp className="size-3.5 shrink-0 text-brand-300" aria-hidden="true" />
              )}
              {person.micOn ? (
                <Mic className="size-3.5 shrink-0 text-white/50" aria-hidden="true" />
              ) : (
                <MicOff className="size-3.5 shrink-0 text-white/25" aria-hidden="true" />
              )}
              {person.isHost && (
                <span className="shrink-0 rounded bg-brand-500/80 px-1.5 py-0.5 text-[10px] font-semibold text-white uppercase">
                  {t('host')}
                </span>
              )}
            </div>

            {/* Everything below is the teacher's, and exists only on their page. */}
            {isHost && !person.isHost && (
              <>
                {(person.asking || person.handUp) && (
                  <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-gold-500/10 p-2">
                    <p className="min-w-0 flex-1 text-[11px] text-gold-200">
                      {person.asking === 'screen'
                        ? t('asksScreen')
                        : person.asking === 'camera'
                          ? t('asksCamera')
                          : t('raisesHand')}
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        onAction(
                          person.identity,
                          person.asking === 'screen' ? 'allow-screen' : 'allow-speak',
                        );
                        onClearAsk(person.identity);
                      }}
                      className="rounded-full bg-brand-500 px-3 py-1 text-[11px] font-medium text-white hover:bg-brand-600"
                    >
                      {person.asking === 'screen' ? t('allow') : t('allowSpeak')}
                    </button>
                    {person.asking && (
                      <button
                        type="button"
                        onClick={() => onClearAsk(person.identity)}
                        className="rounded-full bg-white/10 px-3 py-1 text-[11px] text-white/80 hover:bg-white/20"
                      >
                        {t('deny')}
                      </button>
                    )}
                  </div>
                )}

                <div className="mt-2 flex items-center gap-1">
                  {/* One decision, not two: a student asked to take part gets
                      the microphone and the camera together, the way a teacher
                      means it. Screen sharing stays its own request. */}
                  <button
                    type="button"
                    title={person.micOn && person.camOn ? t('denySpeak') : t('allowSpeak')}
                    onClick={() =>
                      onAction(
                        person.identity,
                        person.micOn && person.camOn ? 'deny-speak' : 'allow-speak',
                      )
                    }
                    className={cn(
                      icon,
                      'text-white/60 hover:bg-white/10 hover:text-white',
                      person.micOn && person.camOn && 'bg-brand-500/20 text-brand-200',
                    )}
                  >
                    {person.micOn && person.camOn ? (
                      <MicOff className="size-3.5" />
                    ) : (
                      <Mic className="size-3.5" />
                    )}
                    <span className="sr-only">
                      {person.micOn && person.camOn ? t('denySpeak') : t('allowSpeak')}
                    </span>
                  </button>

                  <button
                    type="button"
                    title={person.sharing ? t('denyScreen') : t('allowScreen')}
                    onClick={() =>
                      onAction(person.identity, person.sharing ? 'deny-screen' : 'allow-screen')
                    }
                    className={cn(icon, 'text-white/60 hover:bg-white/10 hover:text-white')}
                  >
                    <MonitorUp className="size-3.5" />
                    <span className="sr-only">
                      {person.sharing ? t('denyScreen') : t('allowScreen')}
                    </span>
                  </button>

                  {/* One student at a time on the big box, the teacher's
                      choice — the same place the microphone and the screen
                      are decided, so the panel reads as one row of controls
                      per person. */}
                  <button
                    type="button"
                    title={person.identity === staged ? t('studentMinimize') : t('studentOnStage')}
                    onClick={() =>
                      onStage(person.identity === staged ? null : person.identity)
                    }
                    className={cn(
                      icon,
                      'text-white/60 hover:bg-white/10 hover:text-white',
                      person.identity === staged && 'bg-brand-500/20 text-brand-200',
                    )}
                  >
                    <Presentation className="size-3.5" />
                    <span className="sr-only">
                      {person.identity === staged ? t('studentMinimize') : t('studentOnStage')}
                    </span>
                  </button>

                  <button
                    type="button"
                    title={t('removeThem')}
                    onClick={() => {
                      if (window.confirm(t('removeConfirm', { name: person.name }))) {
                        onAction(person.identity, 'remove');
                      }
                    }}
                    className={cn(icon, 'ms-auto text-red-300 hover:bg-red-500/20')}
                  >
                    <UserMinus className="size-3.5" />
                    <span className="sr-only">{t('removeThem')}</span>
                  </button>
                </div>
              </>
            )}
          </li>
        ))}
      </ul>

      {isHost && removed.length > 0 && (
        <section className="border-t border-white/10 p-3">
          <h3 className="text-[10px] font-semibold tracking-wide text-white/40 uppercase">
            {t('removedPeople')}
          </h3>
          <ul className="mt-2 space-y-1.5">
            {removed.map((person) => (
              <li key={person.userId} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[12px] text-white/50">
                  {person.name}
                </span>
                <button
                  type="button"
                  onClick={() => onRestore(person.userId)}
                  title={t('restoreThem')}
                  className="inline-flex items-center gap-1 rounded-full bg-white/10 px-2.5 py-1 text-[11px] text-white/80 transition-colors hover:bg-brand-500 hover:text-white"
                >
                  <UserPlus className="size-3" aria-hidden="true" />
                  {t('restoreThem')}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
