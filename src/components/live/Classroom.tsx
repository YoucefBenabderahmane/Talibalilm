'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  Loader2,
  Maximize2,
  MessageSquare,
  Minimize2,
  PresentationIcon,
  SquarePen,
  Upload,
  Users,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useRoom } from './useRoom';
import { Stage } from './Stage';
import { Controls } from './Controls';
import { ChatPanel } from './ChatPanel';
import { ParticipantsPanel, type HostAction } from './ParticipantsPanel';
import { Whiteboard } from './Whiteboard';
import { SlidesPanel } from './SlidesPanel';
import { SharePip } from './SharePip';
import { RemoteAudio } from './RemoteAudio';
import { useSlideUpload } from './useSlideUpload';
import { useRecorder } from './useRecorder';
import {
  clearBoard as clearBoardAction,
  controlParticipant,
  endLiveSessionById,
} from '@/app/actions/live';
import { clearSlides, removeSlide } from '@/app/actions/slides';
import { removeAt } from '@/lib/live/deck';
import type { BoardOp, RoomMessage } from '@/lib/live/protocol';
import type { LiveRoomState } from '@/lib/supabase/database.types';

type Tab = 'chat' | 'people' | 'board' | 'slides';
type SlideItem = { id: string; url: string | null; filename: string };

/**
 * The classroom.
 *
 * The room this replaced was an embedded third-party page, and the teacher
 * joined their own class as a student because that server would not mint a
 * token telling it otherwise. Here the role arrives as a prop, decided by the
 * database before this component exists, and the host controls are simply not
 * part of a student's page — not hidden, not disabled, absent.
 *
 * The same fact is enforced twice more, because a hidden button is a courtesy
 * rather than a rule: a student's LiveKit token carries no camera source until
 * the teacher allows one, and every browser drops a host-only message that did
 * not come from the teacher's signed identity.
 *
 * What the teacher is looking at travels as `focus`, and the class follows it.
 * A student may wander between tabs, and stays where they wandered until the
 * teacher moves again — following is not the same as being pulled around.
 */
export function Classroom({
  roomToken,
  sessionId,
  title,
  room: initial,
  slides,
  boardHistory,
  chatHistory,
  removedPeople,
  recordingBaseName,
}: {
  roomToken: string;
  sessionId: string;
  title: string;
  /** What the server says this viewer may do. The UI never infers it. */
  room: LiveRoomState;
  slides: SlideItem[];
  boardHistory: BoardOp[];
  chatHistory: { id: string; name: string; isHost: boolean; body: string; at: number }[];
  /** Banned and not yet allowed back — staff-visible attendance rows. */
  removedPeople: { userId: string; name: string }[];
  recordingBaseName: string;
}) {
  const t = useTranslations('live');
  const isHost = initial.is_host;

  const [tab, setTab] = useState<Tab>(isHost ? 'people' : 'chat');
  const [panelOpen, setPanelOpen] = useState(false);
  const [slide, setSlide] = useState(-1);
  const [deck, setDeck] = useState<SlideItem[]>(slides);
  /** Why the last removal failed, kept apart from the upload refusals. */
  const [deckError, setDeckError] = useState<{ error: string; detail?: string | null } | null>(
    null,
  );
  const [board, setBoard] = useState<{ ops: BoardOp[]; clearedAt: number }>({
    ops: [],
    clearedAt: 0,
  });
  /** The board in a 320px column is not something anyone can teach on. */
  const [boardOnStage, setBoardOnStage] = useState(false);
  /**
   * A running share reduced to the corner while the slide or the board has the
   * stage. The teacher's decision, sent as part of `focus` so the class sees
   * the same layout — Meet's "minimize", not "stop sharing".
   */
  const [sharePip, setSharePip] = useState(false);
  const [panelWidth, setPanelWidth] = useState(340);
  const [removed, setRemoved] = useState(removedPeople);
  /** A file is over the room; the class is about to get a new slide. */
  const [dropping, setDropping] = useState(false);
  /** Bumped by a `sync` message, so the teacher re-announces where the lesson is. */
  const [syncAsk, setSyncAsk] = useState(0);
  /** Chat lines that arrived while another tab was open. */
  const [unread, setUnread] = useState(0);

  const stageRef = useRef<HTMLDivElement | null>(null);
  const deckRef = useRef(deck);
  /** Slide ids whose one-off signing request is already in flight. */
  const signing = useRef<Set<string>>(new Set());
  /** Board strokes waiting to be persisted, and the timer that flushes them. */
  const boardQueue = useRef<BoardOp[]>([]);
  const boardFlush = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The tab strip and controls, measured so the phone sheet can stop above them. */
  const footRef = useRef<HTMLDivElement | null>(null);
  const [footHeight, setFootHeight] = useState(0);

  /**
   * The deck, re-read from the server.
   *
   * Called when the teacher announces one changed: the slides were signed for
   * each viewer separately, so the class cannot be handed the teacher's links.
   */
  const refreshDeck = useCallback(() => {
    void fetch(`/api/live/slides?session=${sessionId}`)
      .then((response) => (response.ok ? response.json() : { slides: [] }))
      .then((body: { slides?: { id: string; url: string | null; filename: string }[] }) => {
        const next = body.slides ?? [];
        setDeck(next);
        // A page removed while this browser was on it must not leave the
        // position past the end of the new deck. The teacher's `slide` message
        // normally arrives first; this is the safety net for when it does not.
        setSlide((s) => (s >= next.length ? next.length - 1 : s));
      })
      .catch(() => {});
  }, [sessionId]);

  /**
   * The link for the one page being shown, fetched when it is first needed.
   *
   * The deck arrives without signed URLs — minting the whole deck on every
   * join is the cost this avoids — so the page on stage asks for its own link
   * and keeps it. `signing` stops the same page being requested twice while
   * the first request is still in flight.
   */
  const ensureSlideUrl = useCallback(
    (index: number) => {
      const item = deckRef.current[index];
      if (!item || item.url || signing.current.has(item.id)) return;

      signing.current.add(item.id);
      void fetch(`/api/live/slides?session=${sessionId}&id=${item.id}`)
        .then((response) => (response.ok ? response.json() : { url: null }))
        .then((body: { url?: string | null }) => {
          if (!body.url) return;
          setDeck((current) =>
            current.map((s) => (s.id === item.id ? { ...s, url: body.url! } : s)),
          );
        })
        .catch(() => {})
        .finally(() => signing.current.delete(item.id));
    },
    [sessionId],
  );

  const onMessage = useCallback(
    (message: RoomMessage) => {
      // Only messages that survived `acceptFrom` reach here, so anything below
      // genuinely came from the teacher.
      if (message.t === 'slide') {
        setSlide(message.i);
        ensureSlideUrl(message.i);
      } else if (message.t === 'board') setBoard((b) => ({ ...b, ops: [...b.ops, message.op] }));
      else if (message.t === 'board-clear') setBoard({ ops: [], clearedAt: Date.now() });
      else if (message.t === 'focus') {
        setTab(message.tab);
        if (message.boardOnStage !== undefined) setBoardOnStage(message.boardOnStage);
        if (message.sharePip !== undefined) setSharePip(message.sharePip);
      } else if (message.t === 'chat') {
        // The teacher missed a whole conversation by not noticing the tab;
        // the badge is the answer to that, not a louder notification.
        if (tab !== 'chat') setUnread((n) => n + 1);
      } else if (message.t === 'deck') refreshDeck();
      else if (message.t === 'sync') setSyncAsk((n) => n + 1);
      else if (message.t === 'ended') window.location.assign('/dashboard');
    },
    [ensureSlideUrl, refreshDeck, tab],
  );

  // Opening the tab is reading it.
  useEffect(() => {
    if (tab === 'chat') setUnread(0);
  }, [tab]);

  const live = useRoom({ roomToken, isHost, onMessage });
  // Pulled out for the effect below: `live` is a fresh object each render, and
  // the effect must fire on the room's state, not on React re-rendering.
  const { status: roomStatus, send: sendToRoom } = live;

  /**
   * Show one slide to the class — the teacher's move, refused from anyone else.
   *
   * A running share is reduced to the corner, never stopped: Meet's rule, and
   * the reason the teacher asked for it. The shared screen keeps running while
   * the class reads the slide, and the corner's expand button puts it back on
   * the stage. Ending a student's share outright is still the participants
   * panel's job, one button away.
   */
  const present = (index: number) => {
    if (live.people.some((p) => p.sharing)) setSharePip(true);
    setSlide(index);
    live.send({ t: 'slide', i: index });
  };

  /**
   * A slide that just landed, from a drop on the room or the panel's button.
   *
   * The deck is kept here rather than re-read after a reload, because the room
   * is mid-lesson: the new page goes up in front of the class, and everyone
   * else is told the deck changed so each browser fetches its own signed copy.
   */
  const addSlide = (slide: SlideItem, index: number) => {
    const at = deckRef.current.length + index;
    const next = [...deckRef.current, slide];
    deckRef.current = next;
    setDeck(next);
    if (index === 0) {
      live.send({ t: 'deck' });
      present(at);
    }
  };

  /**
   * Take one page off the deck, mid-lesson.
   *
   * The server goes first: the row and its object are removed, and only then
   * does the class see the deck change. A failure leaves the deck as it was
   * and says why, rather than dropping a page every other browser still has.
   */
  const removeSlideAt = async (id: string) => {
    if (!isHost) return;
    // The id, not the index the thumbnail was rendered with: an upload landing
    // between render and click would otherwise shift the deck under the click
    // and delete the wrong page.
    const index = deckRef.current.findIndex((s) => s.id === id);
    if (index < 0) return;

    setDeckError(null);
    const result = await removeSlide({ id, sessionId });
    if (!result.ok) {
      setDeckError({ error: result.error ?? 'saveFailed', detail: result.detail });
      return;
    }

    const after = removeAt(deckRef.current, slideRef.current, index);
    deckRef.current = after.deck;
    setDeck(after.deck);
    // Every viewer re-reads its own signed copy, then the class follows the
    // teacher to wherever the removal left the presentation.
    live.send({ t: 'deck' });
    if (after.current >= 0) present(after.current);
    else setSlide(-1);
  };

  /**
   * Empty the deck, mid-lesson.
   *
   * The server goes first, exactly as a single removal does: only once the rows
   * and their objects are gone does the class see an empty deck. Every other
   * viewer re-reads its own signed copy, which is now nothing.
   */
  const clearDeck = async () => {
    if (!isHost) return;
    setDeckError(null);
    const result = await clearSlides(sessionId);
    if (!result.ok) {
      setDeckError({ error: result.error ?? 'saveFailed', detail: result.detail });
      return;
    }
    deckRef.current = [];
    setDeck([]);
    setSlide(-1);
    live.send({ t: 'deck' });
  };

  /**
   * Whether the class is being recorded, read at conversion time.
   *
   * A ref rather than state: a conversion asks once, when it starts, and the
   * answer must not rebuild the upload callback — or the recorder — on every
   * tick of the timer.
   */
  const recordingActive = useRef(false);
  const deckUpload = useSlideUpload(sessionId, {
    onAdded: addSlide,
    lowPriority: () => recordingActive.current,
  });

  /**
   * What the recorder captures.
   *
   * Whatever is on the stage — the teacher, a shared screen, a slide, the
   * whiteboard — read from the DOM at each frame rather than held in state, so
   * switching between them mid-lesson needs no restart. The audio is every live
   * track in the room; the teacher's own microphone is added by the recorder,
   * because the room carries no copy of a voice the browser never plays back.
   */
  const recorder = useRecorder(recordingBaseName, {
    // Whatever the stage shows, plus the reduced share in its corner: every
    // element the room marks, framed on the stage box. The file matches the
    // class's view rather than one element of it.
    stage: () => {
      const container = stageRef.current?.querySelector<HTMLElement>('[data-record-container]');
      if (!container) return null;
      const items = Array.from(container.querySelectorAll<HTMLElement>('[data-record]')).map(
        (element) => ({
          element: element as HTMLVideoElement | HTMLImageElement | HTMLCanvasElement,
          rect: element.getBoundingClientRect(),
        }),
      );
      if (items.length === 0) return null;
      return { container: container.getBoundingClientRect(), items };
    },
    audio: () =>
      Array.from(live.room.remoteParticipants.values())
        .flatMap((p) => Array.from(p.trackPublications.values()))
        .map((pub) => pub.track?.mediaStreamTrack)
        .filter((t): t is MediaStreamTrack => !!t && t.kind === 'audio'),
  });

  // Kept for the upload's low-priority check: while this is true, a PDF
  // conversion keeps two workers instead of four.
  useEffect(() => {
    recordingActive.current = recorder.state !== 'idle';
  }, [recorder.state]);

  // History arrives from the database, already filtered by the same policies
  // that guard the room, so a late joiner sees the lesson so far.
  useEffect(() => {
    live.setChat(
      chatHistory.map((line) => ({
        id: line.id,
        identity: '',
        name: line.name,
        isHost: line.isHost,
        body: line.body,
        at: line.at,
      })),
    );
    // Once, on entry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the deck ref level with the state, so a batch of uploads appended in
  // the same tick counts from the right place.
  useEffect(() => {
    deckRef.current = deck;
  }, [deck]);

  // The current slide, for the one effect that answers a latecomer without
  // re-announcing the lesson every time the teacher advances a page.
  const slideRef = useRef(slide);
  useEffect(() => {
    slideRef.current = slide;
  }, [slide]);

  // The controls are the one thing that must stay under a thumb while a sheet
  // is open, so the sheet's content stops where they begin.
  useEffect(() => {
    const foot = footRef.current;
    if (!foot) return;
    const measure = () => setFootHeight(foot.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(foot);
    return () => observer.disconnect();
  }, []);

  /**
   * Tell the class where the lesson is.
   *
   * Sent on connect as well as on every move, so a student who joins halfway
   * through finds the teacher's tab and stage rather than the default ones.
   */
  useEffect(() => {
    if (!isHost || roomStatus !== 'connected') return;
    sendToRoom({ t: 'focus', tab, boardOnStage, sharePip });
  }, [isHost, tab, boardOnStage, sharePip, roomStatus, sendToRoom]);

  // A student asks once, on entry. The teacher's answer arrives as an ordinary
  // focus message, so a browser that joins halfway through opens on the lesson
  // rather than on whatever tab the door led to.
  useEffect(() => {
    if (isHost || roomStatus !== 'connected') return;
    sendToRoom({ t: 'sync' });
  }, [isHost, roomStatus, sendToRoom]);

  // The teacher's half: answer a latecomer with the tab, the stage and the
  // page the class is on. Only when asked — this must not fire on every slide.
  useEffect(() => {
    if (!isHost || roomStatus !== 'connected' || syncAsk === 0) return;
    sendToRoom({ t: 'focus', tab, boardOnStage, sharePip });
    if (slideRef.current >= 0) sendToRoom({ t: 'slide', i: slideRef.current });
    // Depends on the ask alone: `tab`, `boardOnStage` and the slide are read
    // through refs or sent by the effects that already watch them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncAsk, isHost, roomStatus, sendToRoom]);

  const presenting = useMemo(
    () =>
      live.people.find((p) => p.sharing && !p.isLocal)?.identity ??
      (live.sharing ? (live.people.find((p) => p.isLocal)?.identity ?? null) : null),
    [live.people, live.sharing],
  );

  const sharer = presenting ? live.people.find((p) => p.identity === presenting) : undefined;
  /** The share owns the stage only while it has not been reduced. */
  const shareOnStage = Boolean(sharer) && !sharePip;

  // A share that has ended leaves nothing to reduce. The next one starts on the
  // stage unless a slide or the board claims it — the start handler decides.
  useEffect(() => {
    if (presenting === null) setSharePip(false);
  }, [presenting]);

  const currentSlideUrl = slide >= 0 ? (deck[slide]?.url ?? null) : null;

  const goToSlide = (index: number) => {
    if (!isHost) return;
    present(index);
  };

  /**
   * Persist a board operation or a chat line.
   *
   * Through `/api/live/*` and not a Server Action, deliberately: an action
   * rebuilds the whole classroom on the server, and a lesson sends hundreds of
   * these — a stroke each time the pen lifts, a line each time somebody
   * speaks. The room has already shown it, so a failed write is a missing
   * replay line rather than a lost message, and nothing is shown to the class.
   */
  const persist = (path: string, payload: unknown) => {
    void fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      // The tab may be closing on the last stroke of a lesson.
      keepalive: true,
    }).catch(() => {});
  };

  /**
   * Board strokes, queued and posted in batches.
   *
   * One request per stroke was one function invocation per stroke — hundreds
   * in a lesson, each paying startup CPU. The room has already drawn them, so
   * persistence can wait a moment and travel together. The queue flushes when
   * it is full, after a short pause, or when the page goes away.
   */
  const flushBoard = useCallback(() => {
    if (boardFlush.current !== null) {
      clearTimeout(boardFlush.current);
      boardFlush.current = null;
    }
    const ops = boardQueue.current;
    boardQueue.current = [];
    if (ops.length === 0) return;
    void fetch('/api/live/board', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, ops }),
      keepalive: true,
    }).catch(() => {});
  }, [sessionId]);

  const queueBoardOp = useCallback(
    (op: BoardOp) => {
      boardQueue.current.push(op);
      if (boardQueue.current.length >= 50) {
        flushBoard();
        return;
      }
      if (boardFlush.current === null) {
        boardFlush.current = setTimeout(flushBoard, 2000);
      }
    },
    [flushBoard],
  );

  useEffect(() => {
    // `pagehide` as well as unmount: closing the tab does not always run a
    // React cleanup, and the last strokes of a lesson are the ones a late
    // joiner is most likely to look for.
    const onHide = () => flushBoard();
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      flushBoard();
    };
  }, [flushBoard]);

  const drawOp = (op: BoardOp) => {
    setBoard((b) => ({ ...b, ops: [...b.ops, op] }));
    live.send({ t: 'board', op });
    // Persisted in batches, so somebody joining late still sees it. The write
    // is refused by policy for anyone but staff, so nothing here checks.
    queueBoardOp(op);
  };

  const clearBoard = () => {
    setBoard({ ops: [], clearedAt: Date.now() });
    live.send({ t: 'board-clear' });
    void clearBoardAction(sessionId);
  };

  const sendChat = (body: string) => {
    live.sendChat(body);
    // Delivery and the record are separate jobs: the room has already shown the
    // line, and a failed insert must not take it back off the screen.
    persist('/api/live/message', { sessionId, body });
  };

  const hostAction = async (identity: string, action: HostAction) => {
    if (action === 'remove') {
      // Listed under the participants straight away: the ban is already on its
      // way to the database, and a person the teacher just removed should not
      // need a reload to become visible again.
      const person = live.people.find((p) => p.identity === identity);
      setRemoved((list) =>
        list.some((r) => r.userId === identity)
          ? list
          : [...list, { userId: identity, name: person?.name ?? '' }],
      );
    }

    const form = new FormData();
    form.set('sessionId', sessionId);
    form.set('userId', identity);
    form.set('action', action);
    // Authorised inside the database, not here: `live_set_participant` refuses
    // anyone who is not staff, whatever this page believes about itself.
    await controlParticipant({ ok: true }, form);
  };

  const restorePerson = async (userId: string) => {
    setRemoved((list) => list.filter((r) => r.userId !== userId));
    const form = new FormData();
    form.set('sessionId', sessionId);
    form.set('userId', userId);
    form.set('action', 'restore');
    await controlParticipant({ ok: true }, form);
  };

  const endClass = async () => {
    if (!window.confirm(t('endConfirm'))) return;
    live.send({ t: 'ended' });
    await endLiveSessionById(sessionId);
    window.location.assign('/admin/live');
  };

  const tabs: { key: Tab; label: string; Icon: typeof Users }[] = [
    { key: 'chat', label: t('tabChat'), Icon: MessageSquare },
    { key: 'people', label: t('tabPeople'), Icon: Users },
    { key: 'board', label: t('tabBoard'), Icon: SquarePen },
    { key: 'slides', label: t('tabSlides'), Icon: PresentationIcon },
  ];

  if (live.status === 'failed' || (live.status === 'closed' && live.error)) {
    // Three different failures used to share one message — "this class is not
    // open" — which sent a teacher hunting for a class nobody had cancelled.
    // They are told apart here, and the underlying reason is shown to staff so
    // a misconfiguration can be fixed rather than guessed at.
    const removedByTeacher = live.error === 'removed';
    const unreachable = live.error === 'unavailable';

    return (
      <main className="flex min-h-dvh items-center justify-center bg-ink px-6 text-center">
        <div className="max-w-md">
          <h1 className="font-display text-xl font-semibold text-white">
            {removedByTeacher
              ? t('removedTitle')
              : unreachable
                ? t('unreachableTitle')
                : t('closedTitle')}
          </h1>
          <p className="mt-2 text-[13px] leading-relaxed text-white/60">
            {removedByTeacher
              ? t('removedBody')
              : unreachable
                ? t('unreachableBody')
                : t('closedBody')}
          </p>

          {isHost && live.detail && (
            <p className="mt-4 rounded-lg bg-white/5 p-3 text-start font-mono text-[11px] break-words text-white/50">
              {live.detail}
            </p>
          )}

          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-5 rounded-full bg-white/10 px-5 py-2 text-[13px] text-white transition-colors hover:bg-white/20"
          >
            {t('retry')}
          </button>
        </div>
      </main>
    );
  }

  /**
   * The teacher moved tabs. When a share is running, the tabs that own the
   * stage take it back: the deck appears and the share drops to the corner,
   * the board expands, and the class follows both through `focus`. Chat and
   * participants have no stage content, so a share stays where it is.
   */
  const focusTab = (key: Tab) => {
    if (key === 'slides') refreshDeck();
    setTab(key);
    if (!live.people.some((p) => p.sharing)) return;
    if (key === 'slides' && deckRef.current.length > 0) {
      present(slideRef.current >= 0 ? slideRef.current : 0);
    } else if (key === 'board') {
      setSharePip(true);
      setBoardOnStage(true);
    }
  };

  /**
   * One strip of tabs, in the two places it lives: across the top of the side
   * panel on a wide screen, and along the bottom of the stage on a phone,
   * where a thumb can reach it. The bar opens the sheet; the panel is already
   * open.
   */
  const tabStrip = (variant: 'panel' | 'bar') => (
    <div
      role="tablist"
      className={cn(
        variant === 'panel'
          ? 'hidden border-b border-white/10 lg:flex'
          : 'flex border-t border-white/10 lg:hidden',
      )}
    >
      {tabs.map(({ key, label, Icon }) => (
        <button
          key={key}
          type="button"
          role="tab"
          aria-selected={tab === key}
          title={label}
          onClick={() => {
            if (variant === 'bar') {
              // Tapping the open tab again puts the sheet away.
              if (panelOpen && tab === key) {
                setPanelOpen(false);
                return;
              }
              // The deck's links are minted when the panel is opened, not when
              // the room is joined: a viewer who never opens it never pays.
              focusTab(key);
              setPanelOpen(true);
              return;
            }
            focusTab(key);
          }}
          className={cn(
            'flex flex-1 items-center justify-center gap-1.5 px-2 py-2.5 text-[12px] transition-colors',
            variant === 'panel' && 'border-b-2',
            variant === 'bar' && 'flex-col gap-0.5 py-2 text-[10px]',
            tab === key
              ? variant === 'panel'
                ? 'border-brand-400 text-white'
                : 'text-brand-300'
              : 'text-white/50 hover:text-white/80',
          )}
        >
          <span className="relative">
            <Icon className={variant === 'bar' ? 'size-5' : 'size-4'} aria-hidden="true" />
            {key === 'chat' && unread > 0 && tab !== 'chat' && (
              <span className="absolute -end-2 -top-1.5 flex size-4 items-center justify-center rounded-full bg-red-500 text-[9px] font-semibold text-white">
                {unread > 9 ? '9+' : unread}
              </span>
            )}
          </span>
          {variant === 'panel' ? (
            <span className="sr-only sm:not-sr-only">{label}</span>
          ) : (
            label
          )}
        </button>
      ))}
    </div>
  );

  const boardCanvas = (
    <Whiteboard
      canDraw={isHost}
      history={boardHistory}
      incoming={board}
      onOp={drawOp}
      onLiveOp={(op) => live.sendLossy({ t: 'board', op })}
      onClear={clearBoard}
    />
  );

  return (
    <div
      // `overflow-hidden` is the room's promise that it is the whole page: the
      // class fills the viewport, and a long unbroken word in the chat must
      // never turn the white body behind it into a scrollable margin.
      className="relative flex h-dvh flex-col overflow-hidden bg-ink text-white"
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        // Swallowed for everyone, so a dropped file never navigates a student
        // away from the lesson. Only the teacher's drop becomes a slide.
        event.preventDefault();
        if (isHost && !dropping) setDropping(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDropping(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDropping(false);
        if (!isHost) return;
        const files = event.dataTransfer.files;
        if (files?.length) void deckUpload.upload(files);
      }}
    >
      <header className="flex items-center gap-3 border-b border-white/10 px-4 py-2.5">
        <h1 className="min-w-0 flex-1 truncate font-display text-[15px] font-semibold">{title}</h1>

        {live.status === 'reconnecting' && (
          <span className="flex items-center gap-1.5 text-[12px] text-gold-300" role="status">
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            {t('reconnecting')}
          </span>
        )}
        {recorder.state === 'recording' && (
          <span className="flex items-center gap-1.5 text-[12px] text-red-300" role="status">
            <span className="size-2 animate-pulse rounded-full bg-red-500" aria-hidden="true" />
            {t('recording')}
          </span>
        )}
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {/* The recorder reads its picture from inside here, so whatever is on
              the stage is what lands in the file — camera, shared screen,
              slide, or the board — with no restart when it changes. */}
          <div ref={stageRef} className="flex min-h-0 flex-1 flex-col">
            {live.status === 'connecting' ? (
              <div className="flex flex-1 items-center justify-center">
                <Loader2 className="size-6 animate-spin text-white/40" aria-hidden="true" />
              </div>
            ) : boardOnStage && !shareOnStage ? (
              <div
                data-record-container
                className="relative m-3 min-h-0 flex-1 overflow-hidden rounded-2xl border border-white/10"
              >
                {boardCanvas}
                {sharer && sharePip && (
                  <SharePip
                    room={live.room}
                    person={sharer}
                    canExpand={isHost}
                    onExpand={() => setSharePip(false)}
                  />
                )}
                <button
                  type="button"
                  onClick={() => setBoardOnStage(false)}
                  title={t('boardShrink')}
                  className="absolute end-2 top-2 rounded-lg bg-black/50 p-2 text-white/80 transition-colors hover:bg-black/70"
                >
                  <Minimize2 className="size-4" aria-hidden="true" />
                  <span className="sr-only">{t('boardShrink')}</span>
                </button>
              </div>
            ) : (
              <Stage
                room={live.room}
                people={live.people}
                presenting={presenting}
                slide={currentSlideUrl}
                canPresent={isHost}
                slideIndex={slide}
                slideTotal={deck.length}
                onGoSlide={goToSlide}
                sharePip={sharePip}
                onMinimizeShare={() => setSharePip(true)}
                onExpandShare={() => setSharePip(false)}
              />
            )}
          </div>

          {/* Everyone's voice, mounted here rather than inside a video tile:
              a camera-off student, anyone past the strip's twelve tiles and
              the sharer all had no audio element at all. */}
          <RemoteAudio room={live.room} />

          {/* The strip and the controls, kept above the phone sheet so a
              teacher can still mute and raise a hand with the panel open. */}
          <div ref={footRef} className="relative z-50 bg-ink lg:z-auto">
            {tabStrip('bar')}

            <Controls
              isHost={isHost}
              micOn={live.micOn}
              camOn={live.camOn}
              sharing={live.sharing}
              handUp={live.handUp}
              // The grant the media server currently holds, not the page the
              // student loaded: an approval mid-lesson must produce a button.
              canMic={isHost || (live.abilities?.mic ?? !initial.muted)}
              canCam={isHost || (live.abilities?.camera ?? initial.camera_allowed)}
              canShare={isHost || (live.abilities?.screen ?? initial.screen_allowed)}
              recording={recorder.state}
              onMic={() => void live.toggleMic()}
              onCam={() => void live.toggleCam()}
              onShare={() => {
                // A share started while the class is reading a slide or the
                // board begins in the corner; with nothing else on stage it
                // takes the stage, as it always has.
                setSharePip(slideRef.current >= 0 || boardOnStage);
                void live.toggleShare();
              }}
              onHand={() => live.raiseHand(!live.handUp)}
              onAskCamera={() => live.send({ t: 'ask', what: 'camera' })}
              onAskScreen={() => live.send({ t: 'ask', what: 'screen' })}
              onRecord={() => {
                if (recorder.state === 'idle') {
                  void recorder.start();
                  live.send({ t: 'rec', on: true });
                } else {
                  recorder.stop();
                  live.send({ t: 'rec', on: false });
                }
              }}
              onPauseRecord={recorder.togglePause}
              onLeave={() => window.location.assign(isHost ? '/admin/live' : '/dashboard')}
              onEnd={() => void endClass()}
            />
          </div>
        </div>

        {/* Drag to widen the panel. The board is the reason it exists: a
            whiteboard in a fixed 320px column is not something anyone can
            teach on, and a teacher's idea of enough room is theirs to set. */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t('resizePanel')}
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft') setPanelWidth((w) => Math.min(720, w + 32));
            if (event.key === 'ArrowRight') setPanelWidth((w) => Math.max(280, w - 32));
          }}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            const move = (e: PointerEvent) => {
              setPanelWidth(Math.min(720, Math.max(280, window.innerWidth - e.clientX)));
            };
            const up = () => {
              window.removeEventListener('pointermove', move);
              window.removeEventListener('pointerup', up);
            };
            window.addEventListener('pointermove', move);
            window.addEventListener('pointerup', up);
          }}
          className="hidden w-1.5 shrink-0 cursor-col-resize bg-white/5 transition-colors hover:bg-brand-500/60 focus-visible:bg-brand-500 lg:block"
        />

        <aside
          style={
            {
              width: panelOpen ? undefined : `${panelWidth}px`,
              // Where the strip and controls begin: the sheet stops there, so
              // they stay reachable while it is open.
              '--foot': `${footHeight}px`,
            } as React.CSSProperties
          }
          className={cn(
            // `min-w-0` so a long unbreakable word in a chat line cannot force
            // the panel past its width and drag the whole room wider than the
            // viewport; `break-words` only bites once the box is constrained.
            'flex min-w-0 flex-col border-white/10 bg-black/25',
            // On a phone it is a sheet over the stage, tall enough to read a
            // chat and shallow enough to keep the lesson in sight.
            'max-lg:fixed max-lg:inset-x-0 max-lg:bottom-0 max-lg:z-40 max-lg:max-h-[70dvh] max-lg:rounded-t-2xl max-lg:border-t max-lg:bg-ink/95 max-lg:pb-[var(--foot)]',
            panelOpen ? 'max-lg:flex' : 'max-lg:hidden',
            // On a wide screen it is a column that is always there.
            'lg:static lg:flex lg:max-w-none lg:border-s',
          )}
        >
          {tabStrip('panel')}

          <div className="flex items-center justify-between border-b border-white/10 px-3 py-2 lg:hidden">
            <span className="text-[12px] font-medium text-white/60">
              {tabs.find((item) => item.key === tab)?.label}
            </span>
            <button
              type="button"
              onClick={() => setPanelOpen(false)}
              title={t('closePanel')}
              className="rounded-lg p-1.5 text-white/60 transition-colors hover:bg-white/10 hover:text-white"
            >
              <X className="size-4" aria-hidden="true" />
              <span className="sr-only">{t('closePanel')}</span>
            </button>
          </div>

          {tab === 'chat' && (
            <ChatPanel
              lines={live.chat}
              canWrite={isHost || (initial.chat_enabled && !initial.muted)}
              closedReason={initial.muted ? 'muted' : 'closed'}
              onSend={sendChat}
            />
          )}
          {tab === 'people' && (
            <ParticipantsPanel
              people={live.people}
              isHost={isHost}
              removed={removed}
              onAction={(identity, action) => void hostAction(identity, action)}
              onRestore={(userId) => void restorePerson(userId)}
              onClearAsk={live.clearAsk}
            />
          )}
          {tab === 'board' &&
            (boardOnStage ? (
              <p className="p-6 text-center text-[12px] text-white/40">{t('boardOnStage')}</p>
            ) : (
              <div className="flex min-h-0 flex-1 flex-col">
                <button
                  type="button"
                  onClick={() => setBoardOnStage(true)}
                  className="flex items-center justify-center gap-2 border-b border-white/10 p-2 text-[12px] text-white/70 transition-colors hover:bg-white/5 hover:text-white"
                >
                  <Maximize2 className="size-3.5" aria-hidden="true" />
                  {t('boardExpand')}
                </button>
                {boardCanvas}
              </div>
            ))}
          {tab === 'slides' && (
            <SlidesPanel
              slides={deck}
              current={slide}
              canPresent={isHost}
              sharing={presenting !== null}
              onGo={goToSlide}
              onRemove={removeSlideAt}
              onClearAll={clearDeck}
              removeError={deckError}
              upload={deckUpload}
            />
          )}
        </aside>
      </div>

      {dropping && (
        <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-ink/80 p-6">
          <div className="rounded-2xl border-2 border-dashed border-brand-400 bg-ink/60 px-10 py-12 text-center">
            <Upload className="mx-auto size-8 text-brand-300" aria-hidden="true" />
            <p className="mt-3 font-display text-[15px] font-semibold">{t('dropSlides')}</p>
            <p className="mt-1 text-[12px] text-white/50">{t('slidesHint')}</p>
          </div>
        </div>
      )}
    </div>
  );
}
