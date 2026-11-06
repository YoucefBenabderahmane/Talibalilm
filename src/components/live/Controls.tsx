'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import {
  Circle,
  Hand,
  Loader2,
  type LucideIcon,
  Mic,
  MicOff,
  MonitorUp,
  MonitorX,
  MoreHorizontal,
  PauseCircle,
  PlayCircle,
  Square,
  Video,
  VideoOff,
} from 'lucide-react';
import { cn } from '@/lib/utils';

/** A side panel the toolbar can open: chat, people, board, slides. */
export interface ToolbarPanel {
  key: string;
  label: string;
  Icon: LucideIcon;
  /** A count on the icon: unread messages, people in the room. */
  badge?: number;
  /** Shown in red rather than grey (unread messages). */
  alert?: boolean;
}

/**
 * How far an item can be pushed into « Plus » when the bar runs out of room.
 * 1 never moves; 2 goes under a phone's width; 3 goes under a narrow column.
 * Measured on the bar itself (a container query), so a teacher who widens the
 * side panel sees the same thing as a student on a small laptop.
 */
type Tier = 1 | 2 | 3;

interface Item {
  key: string;
  label: string;
  /** The full words, for the tooltip and the « Plus » menu, when `label` is cut short. */
  title?: string;
  /** What fits under the icon on a phone, where every button gets a fifth. */
  shortLabel?: string;
  icon: ReactNode;
  onClick: () => void;
  tier: Tier;
  pressed?: boolean;
  disabled?: boolean;
  badge?: ReactNode;
}

const HIDE_IN_BAR: Record<Tier, string> = {
  1: '',
  2: '@max-[760px]:hidden',
  3: '@max-[960px]:hidden',
};
/** The same items, in the « Plus » menu only once they have left the bar. */
const SHOW_IN_MENU: Record<Tier, string> = {
  1: 'hidden',
  2: '@min-[760px]:hidden',
  3: '',
};

/**
 * The bar along the bottom, laid out like the meeting software everyone
 * already knows: an icon over a short label, the microphone and camera first,
 * the room's panels in the middle, leaving on the right.
 *
 * What appears here is decided by what the server granted, not by role alone: a
 * student allowed a camera by the teacher sees a camera button, and a student
 * who is not sees « Demander la caméra ». A disabled button that says "ask
 * your teacher" would be honest but useless; an absent one is honest and quiet.
 *
 * Ending the class is the teacher's, and it is set apart from Leave. On a phone
 * both move to the top bar (see Classroom), where this bar has no room for them.
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
  panels,
  openPanel,
  onPanel,
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
  panels: ToolbarPanel[];
  /** The panel currently open, if any: its button reads as pressed. */
  openPanel: string | null;
  onPanel: (key: string) => void;
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
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // The menu closes on a click anywhere else, and on Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const away = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('pointerdown', away);
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('pointerdown', away);
      window.removeEventListener('keydown', escape);
    };
  }, [menuOpen]);

  const icon = 'size-[22px]';
  const items: Item[] = [];

  if (canMic) {
    items.push({
      key: 'mic',
      label: micOn ? t('micOn') : t('micOff'),
      icon: micOn ? (
        <Mic className={icon} aria-hidden="true" />
      ) : (
        <MicOff className={cn(icon, 'text-red-500')} aria-hidden="true" />
      ),
      onClick: onMic,
      tier: 1,
    });
  }

  if (canCam) {
    items.push({
      key: 'cam',
      label: camOn ? t('camOn') : t('camOff'),
      icon: camOn ? (
        <Video className={icon} aria-hidden="true" />
      ) : (
        <VideoOff className={cn(icon, 'text-red-500')} aria-hidden="true" />
      ),
      onClick: onCam,
      tier: 1,
    });
  } else if (!isHost) {
    items.push({
      key: 'ask-cam',
      label: t('askCamera'),
      shortLabel: t('camOn'),
      icon: <Video className={icon} aria-hidden="true" />,
      onClick: onAskCamera,
      tier: 1,
    });
  }

  if (!isHost) {
    items.push({
      key: 'hand',
      label: handUp ? t('handDown') : t('handUp'),
      shortLabel: t('handShort'),
      icon: <Hand className={cn(icon, handUp && 'text-gold-400')} aria-hidden="true" />,
      onClick: onHand,
      pressed: handUp,
      tier: 1,
    });
  }

  if (canShare) {
    items.push({
      key: 'share',
      label: sharing ? t('stopShare') : t('share'),
      shortLabel: sharing ? t('stopShareShort') : t('shareShort'),
      icon: sharing ? (
        <MonitorX className={cn(icon, 'text-red-500')} aria-hidden="true" />
      ) : (
        <MonitorUp className={cn(icon, 'text-room-green')} aria-hidden="true" />
      ),
      onClick: onShare,
      pressed: sharing,
      tier: isHost ? 1 : 2,
    });
  } else if (!isHost) {
    items.push({
      key: 'ask-share',
      label: t('askScreen'),
      icon: <MonitorUp className={icon} aria-hidden="true" />,
      onClick: onAskScreen,
      tier: 2,
    });
  }

  for (const panel of panels) {
    const Icon = panel.Icon;
    items.push({
      key: `panel-${panel.key}`,
      label: panel.label,
      icon: <Icon className={icon} aria-hidden="true" />,
      onClick: () => onPanel(panel.key),
      pressed: openPanel === panel.key,
      // Chat stays in reach on a phone; the room's other panels can wait in
      // « Plus » on the narrowest screens.
      tier: panel.key === 'chat' ? 1 : panel.key === 'people' ? 2 : 3,
      badge:
        panel.badge && panel.badge > 0 ? (
          <span
            className={cn(
              'absolute -end-3 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9px] font-semibold tabular-nums',
              panel.alert ? 'bg-red-500 text-white' : 'bg-room-line text-white/85',
            )}
          >
            {panel.badge > 99 ? '99+' : panel.badge}
          </span>
        ) : undefined,
    });
  }

  if (isHost) {
    if (recording === 'idle' || recording === 'saving' || recording === 'starting') {
      items.push({
        key: 'record',
        label:
          recording === 'saving'
            ? t('saving')
            : recording === 'starting'
              ? t('startingRecording')
              : t('startRecording'),
        icon:
          recording === 'idle' ? (
            <Circle className={cn(icon, 'fill-red-500 text-red-500')} aria-hidden="true" />
          ) : (
            <Loader2 className={cn(icon, 'animate-spin')} aria-hidden="true" />
          ),
        onClick: onRecord,
        disabled: recording !== 'idle',
        tier: 2,
      });
    } else {
      items.push({
        key: 'record-pause',
        label: recording === 'paused' ? t('resumeRecording') : t('pauseRecording'),
        icon:
          recording === 'paused' ? (
            <PlayCircle className={icon} aria-hidden="true" />
          ) : (
            <PauseCircle className={icon} aria-hidden="true" />
          ),
        onClick: onPauseRecord,
        tier: 3,
      });
      items.push({
        key: 'record-stop',
        label: t('stopRecordingShort'),
        title: t('stopRecording'),
        icon: <Square className={cn(icon, 'fill-red-500 text-red-500')} aria-hidden="true" />,
        onClick: onRecord,
        tier: 2,
      });
    }
  }

  const inMenu = items.filter((item) => item.tier !== 1);

  return (
    <div className="@container border-t border-room-line/70 bg-room-bar">
      <div className="flex items-center gap-1 px-1 py-1.5 sm:px-3">
        <div className="flex min-w-0 flex-1 items-center justify-center gap-0.5">
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={item.onClick}
              disabled={item.disabled}
              aria-pressed={item.pressed}
              title={item.title ?? item.label}
              className={cn(
                'relative flex min-w-[60px] shrink-0 flex-col items-center gap-1 rounded-lg px-2 pt-1.5 pb-1 text-white/85 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-40',
                '@max-[480px]:min-w-0 @max-[480px]:flex-1 @max-[480px]:px-0.5',
                item.pressed && 'bg-white/10 text-white',
                HIDE_IN_BAR[item.tier],
              )}
            >
              <span className="relative flex h-[22px] items-center">
                {item.icon}
                {item.badge}
              </span>
              <span className="max-w-[8.5rem] truncate text-[11px] leading-tight @max-[480px]:hidden">
                {item.label}
              </span>
              <span className="max-w-full truncate text-[10px] leading-tight @min-[480px]:hidden">
                {item.shortLabel ?? item.label}
              </span>
            </button>
          ))}

          {inMenu.length > 0 && (
            <div
              ref={menuRef}
              className="relative shrink-0 @min-[960px]:hidden @max-[480px]:min-w-0 @max-[480px]:flex-1"
            >
              <button
                type="button"
                onClick={() => setMenuOpen((open) => !open)}
                aria-expanded={menuOpen}
                aria-haspopup="menu"
                title={t('more')}
                className={cn(
                  'relative flex min-w-[60px] flex-col items-center gap-1 rounded-lg px-2 pt-1.5 pb-1 text-white/85 transition-colors hover:bg-white/10 hover:text-white @max-[480px]:w-full @max-[480px]:min-w-0 @max-[480px]:px-0.5',
                  menuOpen && 'bg-white/10 text-white',
                )}
              >
                <span className="relative flex h-[22px] items-center">
                  <MoreHorizontal className={icon} aria-hidden="true" />
                </span>
                <span className="text-[11px] leading-tight @max-[480px]:text-[10px]">{t('more')}</span>
              </button>

              {menuOpen && (
                <div
                  role="menu"
                  className="absolute end-0 bottom-full z-50 mb-2 w-64 rounded-xl border border-room-line bg-room-raised py-1.5 shadow-2xl"
                >
                  {inMenu.map((item) => (
                    <button
                      key={item.key}
                      type="button"
                      role="menuitem"
                      disabled={item.disabled}
                      onClick={() => {
                        setMenuOpen(false);
                        item.onClick();
                      }}
                      className={cn(
                        'flex w-full items-center gap-3 px-3.5 py-2.5 text-start text-[13px] text-white/90 transition-colors hover:bg-white/10 disabled:opacity-40',
                        item.pressed && 'bg-white/5 text-white',
                        SHOW_IN_MENU[item.tier],
                      )}
                    >
                      <span className="relative flex size-6 shrink-0 items-center justify-center [&_svg]:size-5">
                        {item.icon}
                        {item.badge}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{item.title ?? item.label}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2 ps-1 max-sm:hidden">
          <button
            type="button"
            onClick={onLeave}
            className={cn(
              'rounded-lg px-4 py-2 text-[13px] font-semibold transition-colors',
              isHost
                ? 'bg-room-raised text-white hover:bg-room-line'
                : 'bg-red-600 text-white hover:bg-red-700',
            )}
          >
            {t('leave')}
          </button>
          {isHost && (
            <button
              type="button"
              onClick={onEnd}
              className="rounded-lg bg-red-600 px-4 py-2 text-[13px] font-semibold whitespace-nowrap text-white transition-colors hover:bg-red-700"
            >
              {t('endForAll')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
