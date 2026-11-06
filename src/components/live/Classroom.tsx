'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  Loader2,
  Maximize2,
  MessageSquare,
  Minimize2,
  Pause,
  Play,
  PresentationIcon,
  Square,
  SquarePen,
  Upload,
  Users,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useRoom } from './useRoom';
import { Stage, type SlideContent } from './Stage';
import { Controls } from './Controls';
import { ChatPanel } from './ChatPanel';
import { ParticipantsPanel, type HostAction } from './ParticipantsPanel';
import { Whiteboard } from './Whiteboard';
import { SlidesPanel, type LivePanelDeck } from './SlidesPanel';
import { SharePip } from './SharePip';
import { RemoteAudio } from './RemoteAudio';
import { useSlideUpload } from './useSlideUpload';
import { downloadsSettled, useRecorder } from './useRecorder';
import { RecorderNotices } from './RecorderNotices';
import { useLiveDeck } from './useLiveDeck';
import { useSlideBroadcast } from './useSlideBroadcast';
import { CanvasHost } from './CanvasHost';
import { SlideVideo } from './SlideVideo';
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
  /**
   * The side panel is open. A wide screen opens it on arrival, as the room
   * always has; a phone starts on the lesson. Either closes it from the panel's
   * ✕ or its toolbar button, the way a meeting app's chat comes and goes.
   */
  const [panelOpen, setPanelOpen] = useState(false);
  const [slide, setSlide] = useState(-1);
  /**
   * A student's view only: the page on stage is from the teacher's live deck,
   * so it arrives as her "slides" video track rather than from `deck`.
   */
  const [liveSlide, setLiveSlide] = useState(false);
  const liveSlideRef = useRef(false);
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
  /** Identity of the student the teacher has brought onto the main stage. */
  const [staged, setStaged] = useState<string | null>(null);
  const [panelWidth, setPanelWidth] = useState(340);
  const [removed, setRemoved] = useState(removedPeople);
  /** A file is over the room; the class is about to get a new slide. */
  const [dropping, setDropping] = useState(false);
  /** Bumped by a `sync` message, so the teacher re-announces where the lesson is. */
  const [syncAsk, setSyncAsk] = useState(0);
  /** Chat lines that arrived while another tab was open. */
  const [unread, setUnread] = useState(0);
  const panelOpenRef = useRef(false);

  const stageRef = useRef<HTMLDivElement | null>(null);
  const deckRef = useRef(deck);

  /**
   * The teacher's live deck: files opened on her own machine and streamed,
   * the way Zoom presents a document. Its pages come after the uploaded deck
   * in her numbering, so `slide` is one position across both.
   */
  const liveDeck = useLiveDeck(sessionId, isHost);
  const { current: livePagesNow, render: renderLivePage } = liveDeck;
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
        const before = deckRef.current.length;
        deckRef.current = next;
        setDeck(next);
        // A page removed while this browser was on it must not leave the
        // position past the end of the new deck. The teacher's `slide` message
        // normally arrives first; this is the safety net for when it does not.
        setSlide((s) => {
          if (s < 0) return s;
          // The teacher's live pages sit after the uploaded deck: a change in
          // the uploaded deck moves them, and they are not past its end.
          if (isHost && s >= before && livePagesNow().length > 0) return s + (next.length - before);
          // A student on a live page is not looking at the uploaded deck.
          if (!isHost && liveSlideRef.current) return s;
          return s >= next.length ? next.length - 1 : s;
        });
      })
      .catch(() => {});
  }, [isHost, livePagesNow, sessionId]);

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
        liveSlideRef.current = message.live === true;
        setLiveSlide(message.live === true);
        if (!message.live) ensureSlideUrl(message.i);
      } else if (message.t === 'board') setBoard((b) => ({ ...b, ops: [...b.ops, message.op] }));
      else if (message.t === 'board-clear') setBoard({ ops: [], clearedAt: Date.now() });
      else if (message.t === 'focus') {
        setTab(message.tab);
        if (message.boardOnStage !== undefined) setBoardOnStage(message.boardOnStage);
        if (message.sharePip !== undefined) setSharePip(message.sharePip);
        if (message.stage !== undefined) setStaged(message.stage);
      } else if (message.t === 'chat') {
        // The teacher missed a whole conversation by not noticing the tab;
        // the badge is the answer to that, not a louder notification. A
        // closed panel hides the chat as surely as another tab does.
        if (tab !== 'chat' || !panelOpenRef.current) setUnread((n) => n + 1);
      } else if (message.t === 'deck') {
        // The teacher's deck changed. A live page still on stage is announced
        // again right behind this message; a deck she emptied is not, and the
        // class must not keep waiting on a stream that has stopped.
        liveSlideRef.current = false;
        setLiveSlide(false);
        refreshDeck();
      }
      else if (message.t === 'sync') setSyncAsk((n) => n + 1);
      else if (message.t === 'ended') window.location.assign('/dashboard');
    },
    [ensureSlideUrl, refreshDeck, tab],
  );

  // Opening the chat is reading it.
  useEffect(() => {
    panelOpenRef.current = panelOpen;
    if (tab === 'chat' && panelOpen) setUnread(0);
  }, [tab, panelOpen]);

  useEffect(() => {
    if (window.matchMedia('(min-width: 1024px)').matches) setPanelOpen(true);
  }, []);

  const live = useRoom({ roomToken, isHost, onMessage });
  // Pulled out for the effect below: `live` is a fresh object each render, and
  // the effect must fire on the room's state, not on React re-rendering.
  const { status: roomStatus, send: sendToRoom } = live;
  const broadcast = useSlideBroadcast(live.room, isHost);
  const { unpublish: unpublishSlides } = broadcast;

  /** The live page at a position of the teacher's deck, if it is one. */
  const livePageAt = (index: number) => {
    if (!isHost) return null;
    const k = index - deckRef.current.length;
    return k >= 0 ? (livePagesNow()[k] ?? null) : null;
  };

  /** Where a reload finds the page the teacher was showing. This tab only. */
  const liveSlideKey = `talibalim-live-page:${sessionId}`;
  const rememberLivePage = (pageId: string | null) => {
    try {
      if (pageId) window.sessionStorage.setItem(liveSlideKey, pageId);
      else window.sessionStorage.removeItem(liveSlideKey);
    } catch {
      /* Only the return after a reload is lost. */
    }
  };

  /** The page the teacher asked for last: an older, slower render never replaces it. */
  const wantedLive = useRef<string | null>(null);

  /**
   * Draw a live page and put it in the stream. Resolves true once the class
   * can see it, false when a newer page was asked for or it could not be drawn
   * (the deck says why).
   */
  const showLive = async (pageId: string, index: number): Promise<boolean> => {
    wantedLive.current = pageId;
    let shown = false;
    // Twice at most: the bitmap can be released by the cache between the
    // render and the draw, and the second render draws it afresh.
    for (let attempt = 0; attempt < 2 && !shown; attempt++) {
      const bitmap = await renderLivePage(pageId, 'stage', 'stage');
      if (wantedLive.current !== pageId) return false;
      if (!bitmap) break;
      shown = await broadcast.show(bitmap);
    }
    // The next pages are drawn while the teacher talks about this one, so
    // turning the page is instant.
    for (const k of [index + 1, index + 2, index - 1]) {
      const page = livePageAt(k);
      if (page) void renderLivePage(page.id, 'stage', 'ahead');
    }
    return shown && wantedLive.current === pageId;
  };

  /**
   * A student the teacher put on the stage opens their camera by themselves.
   *
   * The click on "show on stage" is the approval; making the student then hunt
   * for their own camera button is the delay the staging was meant to remove.
   * Only on the transition onto the stage — a student who turns the camera off
   * afterwards is respected, and re-staging them opens it again.
   *
   * The permission may arrive a moment after the stage message; this effect
   * waits for it rather than giving up, because `allow-speak` reaches LiveKit
   * and the browser through two different paths.
   */
  const openedFor = useRef<string | null>(null);
  useEffect(() => {
    if (isHost) return;
    if (!staged || staged !== live.room.localParticipant.identity) {
      openedFor.current = null;
      return;
    }
    if (openedFor.current === staged) return;
    if (live.camOn) {
      openedFor.current = staged;
      return;
    }
    if (!(live.abilities?.camera ?? initial.camera_allowed)) return;
    openedFor.current = staged;
    void live.room.localParticipant.setCameraEnabled(true).catch(() => {});
  }, [isHost, staged, live.room, live.camOn, live.abilities, initial.camera_allowed]);

  /**
   * Show one slide to the class — the teacher's move, refused from anyone else.
   *
   * A running share is reduced to the corner, never stopped: Meet's rule, and
   * the reason the teacher asked for it. The shared screen keeps running while
   * the class reads the slide, and the corner's expand button puts it back on
   * the stage. Ending a student's share outright is still the participants
   * panel's job, one button away.
   *
   * A slide takes the stage from a student the teacher had put there: the
   * latest explicit move is the one the class sees.
   */
  const present = (index: number) => {
    if (live.people.some((p) => p.sharing)) setSharePip(true);
    setStaged(null);
    setSlide(index);
    const page = livePageAt(index);
    if (!page) {
      wantedLive.current = null;
      rememberLivePage(null);
      live.send({ t: 'slide', i: index });
      return;
    }
    rememberLivePage(page.id);
    // The class switches once the page is in the stream, so nobody sees the
    // previous page flash up as the new one.
    void showLive(page.id, index).then((shown) => {
      if (shown) live.send({ t: 'slide', i: index, live: true });
    });
  };

  /**
   * Put a student on the big stage, or take them off it.
   *
   * The teacher's decision travels as `focus`, so the whole class sees the same
   * layout — and so does a late joiner, through the sync answer. Staging is
   * also an approval: a camera in this room is granted only to a student who
   * may speak, so the same one-decision `allow-speak` the participants panel
   * already gives is applied first, and the student's own page opens the
   * camera when the permission arrives.
   */
  const stageStudent = (identity: string | null) => {
    if (!isHost) return;
    setStaged(identity);
    if (!identity) return;

    // One content at a time: the student replaces the board, and a running
    // share drops to the corner rather than being stopped.
    setBoardOnStage(false);
    if (live.people.some((p) => p.sharing)) setSharePip(true);

    const person = live.people.find((p) => p.identity === identity);
    if (person && !person.camOn) void hostAction(identity, 'allow-speak');
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

    // One numbering across the uploaded deck and the live pages after it.
    const positions = [...deckRef.current.map((s) => s.id), ...livePagesNow().map((p) => p.id)];
    const after = removeAt(positions, slideRef.current, index);
    const nextDeck = deckRef.current.filter((s) => s.id !== id);
    deckRef.current = nextDeck;
    setDeck(nextDeck);
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
    if (deckRef.current.length > 0) {
      const result = await clearSlides(sessionId);
      if (!result.ok) {
        setDeckError({ error: result.error ?? 'saveFailed', detail: result.detail });
        return;
      }
      deckRef.current = [];
      setDeck([]);
    }
    // The live pages are on this machine: nothing to ask the server.
    liveDeck.clear();
    wantedLive.current = null;
    rememberLivePage(null);
    setSlide(-1);
    live.send({ t: 'deck' });
  };

  /**
   * Take one live page off the deck. Nothing to wait for — the page is on this
   * machine — and the class follows the teacher exactly as for an uploaded one.
   */
  const removeLivePage = (pageId: string) => {
    if (!isHost) return;
    const pages = livePagesNow();
    const k = pages.findIndex((p) => p.id === pageId);
    if (k < 0) return;
    const index = deckRef.current.length + k;
    const positions = [...deckRef.current.map((s) => s.id), ...pages.map((p) => p.id)];
    const before = slideRef.current;
    const after = removeAt(positions, before, index);
    liveDeck.remove(pageId);
    if (before < 0) return;
    if (after.current < 0) {
      wantedLive.current = null;
      rememberLivePage(null);
      setSlide(-1);
      // Nothing left to show: the class leaves the live page too.
      live.send({ t: 'deck' });
    } else if (after.current !== before || index === before) {
      present(after.current);
    }
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
   * A drop on the room or a pick from the panel's button. Opened on this
   * machine and streamed where the browser can; uploaded as before where it
   * cannot. Either way the first new page goes up in front of the class.
   */
  const addFiles = async (files: FileList | File[]) => {
    if (!liveDeck.supported) {
      await deckUpload.upload(files);
      return;
    }
    const first = await liveDeck.open(files);
    if (first !== null) present(deckRef.current.length + first);
  };
  const slideUpload = { ...deckUpload, upload: addFiles };

  const renderThumb = useCallback(
    (pageId: string) => renderLivePage(pageId, 'thumb', 'thumb'),
    [renderLivePage],
  );

  // An emptied live deck stops streaming; the next page shown starts it again.
  useEffect(() => {
    if (isHost && liveDeck.pages.length === 0) unpublishSlides();
  }, [isHost, liveDeck.pages.length, unpublishSlides]);

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

  // The class is told when the recording starts and when it ends — including
  // when it ends on its own (a failure saved what it had), not only when the
  // teacher presses « Arrêter ».
  const announcedRecording = useRef(false);
  useEffect(() => {
    if (!isHost || roomStatus !== 'connected') return;
    const on = recorder.state === 'recording' || recorder.state === 'paused';
    if (on === announcedRecording.current) return;
    announcedRecording.current = on;
    sendToRoom({ t: 'rec', on });
  }, [isHost, roomStatus, sendToRoom, recorder.state]);

  // Closing the tab mid-recording asks first. The disk copy would survive it,
  // but a teacher should not have to rely on recovery for a slip of the hand.
  const recordingNow = recorder.state !== 'idle';
  /** Set by the room's own buttons once the file is saved: no second question. */
  const leaving = useRef(false);
  useEffect(() => {
    if (!recordingNow) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (leaving.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [recordingNow]);

  /**
   * Save the recording before anything takes the page away. True when there
   * was nothing to save or the file has been handed over; false when saving
   * failed — the room then stays open, the notice above it says why, and the
   * copy kept on this machine is offered again on reload.
   */
  const saveRecording = async (): Promise<boolean> => {
    if (recorder.state === 'idle') return true;
    // Stopped while still starting: nothing was recorded, nothing to lose.
    const hadRecording = recorder.state !== 'starting';
    const saved = await recorder.stop();
    if (saved || !hadRecording) return true;
    window.alert(t('recordNotSaved'));
    return false;
  };

  /** Save the file before the page goes away, whichever button sends it away. */
  const leaveTo = async (href: string) => {
    if (!(await saveRecording())) return;
    leaving.current = true;
    await downloadsSettled();
    window.location.assign(href);
  };

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
    sendToRoom({ t: 'focus', tab, boardOnStage, sharePip, stage: staged });
  }, [isHost, tab, boardOnStage, sharePip, staged, roomStatus, sendToRoom]);

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
    sendToRoom({ t: 'focus', tab, boardOnStage, sharePip, stage: staged });
    if (slideRef.current >= 0) {
      sendToRoom(
        livePageAt(slideRef.current)
          ? { t: 'slide', i: slideRef.current, live: true }
          : { t: 'slide', i: slideRef.current },
      );
    }
    // Depends on the ask alone: `tab`, `boardOnStage`, `sharePip` and the
    // staged student are read through this render's values, which are current
    // when the ask arrives; the slide is read through its ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncAsk, isHost, roomStatus, sendToRoom]);

  // After a reload, the live deck comes back from this machine's copy, and the
  // page the teacher was showing goes back up — the class sees the lesson
  // resume where it was rather than an empty stage.
  const resumedLive = useRef(false);
  useEffect(() => {
    if (!isHost || resumedLive.current || !liveDeck.restored || roomStatus !== 'connected') return;
    resumedLive.current = true;
    if (slideRef.current >= 0 || liveDeck.pages.length === 0) return;
    let wanted: string | null = null;
    try {
      wanted = window.sessionStorage.getItem(liveSlideKey);
    } catch {
      /* Nothing to resume. */
    }
    const k = wanted ? liveDeck.pages.findIndex((p) => p.id === wanted) : -1;
    if (k >= 0) present(deckRef.current.length + k);
    // Once, when the restore is done and the room is up.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHost, liveDeck.restored, liveDeck.pages, roomStatus]);

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

  const hostIdentity = live.people.find((p) => p.isHost)?.identity ?? null;
  const hostLivePage =
    isHost && slide >= deck.length ? (liveDeck.pages[slide - deck.length] ?? null) : null;
  const slideUrl = slide >= 0 ? (deck[slide]?.url ?? null) : null;
  const slideTotal = deck.length + (isHost ? liveDeck.pages.length : 0);
  const stageSlide: SlideContent | null =
    slide < 0
      ? null
      : hostLivePage
        ? // The teacher sees the very canvas the class is streamed from.
          { kind: 'live', key: hostLivePage.id, node: <CanvasHost canvas={broadcast.canvas()} /> }
        : !isHost && liveSlide
          ? {
              kind: 'live',
              key: `live:${slide}`,
              node: <SlideVideo room={live.room} hostIdentity={hostIdentity} />,
            }
          : slideUrl
            ? { kind: 'image', src: slideUrl }
            : null;

  const livePanel: LivePanelDeck = {
    pages: liveDeck.pages,
    render: renderThumb,
    onRemove: removeLivePage,
    opening: liveDeck.opening,
    error: liveDeck.error,
    notice: liveDeck.notice,
    broadcastError: broadcast.error,
  };

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

  /**
   * End the class for everyone, in an order that loses nothing.
   *
   * The recording first: its download is started — a hand-over, not a wait —
   * and only a download that could not start keeps the class open. Then the
   * server, and only once it has said yes is the class told — a refusal
   * leaves everyone in the room, with the cause on the teacher's screen,
   * rather than sending the students away from a class that is still open.
   */
  const endClass = async () => {
    if (!window.confirm(t('endConfirm'))) return;
    if (!(await saveRecording())) return;
    // A refusal comes back as a result; a dropped connection as a throw. Both
    // keep the class open and show the cause.
    const result = await endLiveSessionById(sessionId).catch((thrown: unknown) => ({
      ok: false as const,
      detail: thrown instanceof Error ? thrown.message : String(thrown),
    }));
    if (!result.ok) {
      window.alert(`${t('endFailed')}${result.detail ? `\n\n${result.detail}` : ''}`);
      return;
    }
    leaving.current = true;
    // The students leave on this message, so it is given a moment to go out
    // before this page unloads and takes the connection with it.
    await Promise.race([live.send({ t: 'ended' }), new Promise((r) => setTimeout(r, 1500))]);
    // The download started before the class was ended; by now it has
    // usually had its moment, so this rarely waits at all.
    await downloadsSettled();
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
      <main className="flex min-h-dvh items-center justify-center bg-room px-6 text-center">
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

          {/* The room is gone but the recording is not: it is saved before
              anything reloads the page. */}
          {isHost && recorder.state !== 'idle' && (
            <button
              type="button"
              onClick={() => void recorder.stop()}
              className="mt-5 me-2 rounded-full bg-red-500 px-5 py-2 text-[13px] text-white transition-colors hover:bg-red-600"
            >
              {t('recordSaveNow')}
            </button>
          )}

          <button
            type="button"
            onClick={() => void leaveTo(window.location.href)}
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
    if (key === 'slides' && deckRef.current.length + livePagesNow().length > 0) {
      present(slideRef.current >= 0 ? slideRef.current : 0);
    } else if (key === 'board') {
      setSharePip(true);
      setBoardOnStage(true);
      setStaged(null);
    }
  };

  /**
   * A panel button in the toolbar: opens that panel, or puts it away when it
   * is the one already open — the way a meeting app's chat and participants
   * come and go. Switching panels goes through `focusTab`, so the class still
   * follows the teacher and the deck's links are still minted only on open.
   */
  const togglePanel = (key: Tab) => {
    if (panelOpen && tab === key) {
      setPanelOpen(false);
      return;
    }
    focusTab(key);
    setPanelOpen(true);
  };

  const panels = tabs.map(({ key, label, Icon }) => ({
    key,
    label,
    Icon,
    badge: key === 'chat' ? unread : key === 'people' ? live.people.length : undefined,
    alert: key === 'chat',
  }));

  /** Leave and end, for the top bar on a phone, where the toolbar has no room. */
  const leaveButtons = (
    <div className="flex shrink-0 items-center gap-1.5 sm:hidden">
      <button
        type="button"
        onClick={() => void leaveTo(isHost ? '/admin/live' : '/dashboard')}
        className={cn(
          'rounded-md px-3 py-1.5 text-[12px] font-semibold transition-colors',
          isHost ? 'bg-room-raised text-white' : 'bg-red-600 text-white',
        )}
      >
        {t('leave')}
      </button>
      {isHost && (
        <button
          type="button"
          onClick={() => void endClass()}
          className="rounded-md bg-red-600 px-3 py-1.5 text-[12px] font-semibold text-white"
        >
          {t('endForAll')}
        </button>
      )}
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
      // `overflow-clip` is the room's promise that it is the whole page: the
      // class fills the viewport, and a long unbroken word in the chat must
      // never turn the white body behind it into a scrollable margin. Clip,
      // not hidden: a hidden box can still be scrolled by script, and a list
      // scrolling its item into view once slid the whole room 55px sideways.
      className="relative flex h-dvh flex-col overflow-clip bg-room text-white"
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
        if (files?.length) void addFiles(files);
      }}
    >
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-room-line/70 bg-room-bar px-3 sm:px-4">
        {/* Recording, in the corner where a meeting app shows it, with its
            pause and stop beside it: the toolbar keeps only « Arrêter », so
            a narrow screen does not lose the bar to three recording buttons. */}
        {recorder.state === 'recording' || recorder.state === 'paused' ? (
          <span className="flex shrink-0 items-center gap-1 rounded-md bg-black/40 py-0.5 ps-2 pe-0.5 text-[11px] font-semibold text-white">
            <span
              className={cn(
                'size-2 rounded-full bg-red-500',
                recorder.state === 'recording' && 'animate-pulse',
              )}
              aria-hidden="true"
            />
            <span role="status" className="max-sm:sr-only">
              {recorder.state === 'paused' ? t('pauseRecording') : t('recording')}
            </span>
            {isHost && (
              <>
                <button
                  type="button"
                  onClick={recorder.togglePause}
                  title={recorder.state === 'paused' ? t('resumeRecording') : t('pauseRecording')}
                  className="ms-1 rounded p-1 text-white/80 transition-colors hover:bg-white/10 hover:text-white"
                >
                  {recorder.state === 'paused' ? (
                    <Play className="size-3.5" aria-hidden="true" />
                  ) : (
                    <Pause className="size-3.5" aria-hidden="true" />
                  )}
                  <span className="sr-only">
                    {recorder.state === 'paused' ? t('resumeRecording') : t('pauseRecording')}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => void recorder.stop()}
                  title={t('stopRecording')}
                  className="rounded p-1 text-white/80 transition-colors hover:bg-white/10 hover:text-white"
                >
                  <Square className="size-3.5 fill-red-500 text-red-500" aria-hidden="true" />
                  <span className="sr-only">{t('stopRecording')}</span>
                </button>
              </>
            )}
          </span>
        ) : null}

        {live.status === 'reconnecting' && (
          <span className="flex shrink-0 items-center gap-1.5 text-[12px] text-gold-300" role="status">
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            {t('reconnecting')}
          </span>
        )}

        <h1 className="min-w-0 flex-1 truncate text-center font-display text-[14px] font-semibold text-white/90">
          {title}
        </h1>

        {/* How many are in the room. The teacher asked for it by name, and it
            is the same list the participants panel shows; nobody is named by
            the number. */}
        <span
          className="flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px] text-white/70"
          title={t('participantsCount', { count: live.people.length })}
        >
          <Users className="size-4" aria-hidden="true" />
          <span className="tabular-nums" aria-hidden="true">
            {live.people.length}
          </span>
          <span className="sr-only">{t('participantsCount', { count: live.people.length })}</span>
        </span>

        {leaveButtons}
      </header>

      {isHost && (
        <RecorderNotices
          issue={recorder.issue}
          warnings={recorder.warnings}
          part={recorder.part}
          recovered={recorder.state === 'idle' ? recorder.recovered : []}
          onDismiss={recorder.dismissIssue}
          onDownloadRecovered={(id) => void recorder.downloadRecovered(id)}
          onDiscardRecovered={(id) => void recorder.discardRecovered(id)}
        />
      )}

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
                className="relative m-2 min-h-0 flex-1 overflow-hidden rounded-lg bg-black"
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
                  className="absolute end-2 top-2 rounded-md bg-black/60 p-2 text-white/80 transition-colors hover:bg-black/80 hover:text-white"
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
                slide={stageSlide}
                canPresent={isHost}
                slideIndex={slide}
                slideTotal={slideTotal}
                onGoSlide={goToSlide}
                sharePip={sharePip}
                onMinimizeShare={() => setSharePip(true)}
                onExpandShare={() => setSharePip(false)}
                staged={staged}
                onStage={stageStudent}
              />
            )}
          </div>

          {/* Everyone's voice, mounted here rather than inside a video tile:
              a camera-off student, anyone past the strip's twelve tiles and
              the sharer all had no audio element at all. */}
          <RemoteAudio room={live.room} />

          {/* The toolbar, kept above the phone sheet so a teacher can still
              mute and a student raise a hand with the panel open. */}
          <div ref={footRef} className="relative z-50 lg:z-auto">
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
              panels={panels}
              openPanel={panelOpen ? tab : null}
              onPanel={(key) => togglePanel(key as Tab)}
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
                // The class hears about it from the effect above, which also
                // covers a recording that ends on its own.
                if (recorder.state === 'idle') void recorder.start();
                else void recorder.stop();
              }}
              onPauseRecord={recorder.togglePause}
              onLeave={() => void leaveTo(isHost ? '/admin/live' : '/dashboard')}
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
          className={cn(
            'hidden w-1 shrink-0 cursor-col-resize bg-room-line/60 transition-colors hover:bg-room-blue focus-visible:bg-room-blue',
            panelOpen && 'lg:block',
          )}
        />

        <aside
          style={
            {
              '--panel-w': `${panelWidth}px`,
              // Where the toolbar begins: the sheet stops there, so it stays
              // reachable while the sheet is open.
              '--foot': `${footHeight}px`,
            } as React.CSSProperties
          }
          className={cn(
            // `min-w-0` so a long unbreakable word in a chat line cannot force
            // the panel past its width and drag the whole room wider than the
            // viewport; `break-words` only bites once the box is constrained.
            // Closed, it is hidden rather than unmounted: the slides list, the
            // chat draft and the board keep their state.
            'min-w-0 flex-col bg-room-bar',
            panelOpen ? 'flex' : 'hidden',
            // On a phone it is a sheet over the stage, tall enough to read a
            // chat and shallow enough to keep the lesson in sight.
            'max-lg:fixed max-lg:inset-x-0 max-lg:bottom-0 max-lg:z-40 max-lg:max-h-[70dvh] max-lg:rounded-t-2xl max-lg:border-t max-lg:border-room-line max-lg:pb-[var(--foot)] max-lg:shadow-2xl',
            // On a wide screen it is a column beside the stage.
            'lg:static lg:w-[var(--panel-w)] lg:shrink-0',
          )}
        >
          <div className="flex h-11 shrink-0 items-center justify-between border-b border-room-line/70 ps-4 pe-2">
            <span className="text-[13px] font-semibold text-white">
              {tabs.find((item) => item.key === tab)?.label}
            </span>
            <button
              type="button"
              onClick={() => setPanelOpen(false)}
              title={t('closePanel')}
              className="rounded-md p-1.5 text-white/60 transition-colors hover:bg-white/10 hover:text-white"
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
              staged={staged}
              removed={removed}
              onAction={(identity, action) => void hostAction(identity, action)}
              onStage={stageStudent}
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
                  onClick={() => {
                    setBoardOnStage(true);
                    // The board is now what the class is looking at; a staged
                    // student steps down, exactly as presenting a slide does.
                    setStaged(null);
                  }}
                  className="flex items-center justify-center gap-2 border-b border-room-line/70 p-2 text-[12px] text-white/75 transition-colors hover:bg-white/5 hover:text-white"
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
              upload={slideUpload}
              live={isHost ? livePanel : undefined}
              presentingLive={!isHost && liveSlide}
            />
          )}
        </aside>
      </div>

      {dropping && (
        <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-room/85 p-6">
          <div className="rounded-2xl border-2 border-dashed border-room-blue bg-room-bar/80 px-10 py-12 text-center">
            <Upload className="mx-auto size-8 text-room-blue" aria-hidden="true" />
            <p className="mt-3 font-display text-[15px] font-semibold">{t('dropSlides')}</p>
            <p className="mt-1 text-[12px] text-white/50">{t('slidesHint')}</p>
          </div>
        </div>
      )}
    </div>
  );
}
