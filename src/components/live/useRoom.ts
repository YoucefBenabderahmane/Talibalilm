'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ConnectionState,
  DisconnectReason,
  Room,
  RoomEvent,
  Track,
  VideoPresets,
  type LocalTrackPublication,
  type Participant,
  type RemoteParticipant,
} from 'livekit-client';
import { TrackSource as ProtoTrackSource } from '@livekit/protocol';
import { newlyAllowed, type RoomAbilities } from '@/lib/live/abilities';
import {
  acceptFrom,
  decodeMessage,
  encodeMessage,
  participantIsHost,
  type RoomMessage,
} from '@/lib/live/protocol';

/**
 * The classroom connection.
 *
 * One hook owns the LiveKit room so the components below it stay presentational
 * and the connection is not rebuilt every time React re-renders a video tile.
 *
 * The token is fetched from our own endpoint, never held in the page, and the
 * endpoint re-asks the database on every renewal — so a student the teacher
 * removes mid-lesson is disconnected rather than lingering until their token
 * would have lapsed.
 */

export interface RoomPerson {
  identity: string;
  name: string;
  isHost: boolean;
  isLocal: boolean;
  micOn: boolean;
  camOn: boolean;
  sharing: boolean;
  speaking: boolean;
  handUp: boolean;
  /** What they last asked the teacher for, if anything. */
  asking: 'camera' | 'screen' | null;
}

export interface ChatLine {
  id: string;
  identity: string;
  name: string;
  isHost: boolean;
  body: string;
  at: number;
}

export type RoomStatus = 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'closed';

interface Options {
  roomToken: string;
  /** Decided by the server and passed down; the UI never infers it. */
  isHost: boolean;
  onMessage?: (message: RoomMessage, fromHost: boolean) => void;
}

export function useRoom({ roomToken, isHost, onMessage }: Options) {
  const room = useMemo(
    () =>
      new Room({
        // The lesson is watched on phone screens as often as on a laptop, so
        // the server sends each viewer a layer it can actually take. 720p is
        // the capture ceiling: enough to read a shared document, and the one
        // this platform can afford to carry for a class.
        adaptiveStream: true,
        dynacast: true,
        videoCaptureDefaults: { resolution: VideoPresets.h720.resolution },
        audioCaptureDefaults: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        publishDefaults: { simulcast: true },
      }),
    [],
  );
  const [status, setStatus] = useState<RoomStatus>('connecting');
  const [error, setError] = useState<string | null>(null);
  /** The underlying failure, shown to staff and logged. Never guessed at. */
  const [detail, setDetail] = useState<string | null>(null);
  const [people, setPeople] = useState<RoomPerson[]>([]);
  const [chat, setChat] = useState<ChatLine[]>([]);
  const [micOn, setMicOn] = useState(false);
  const [camOn, setCamOn] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [handUp, setHandUp] = useState(false);
  const [abilities, setAbilities] = useState<RoomAbilities | null>(null);

  // Hands and pending requests live outside LiveKit's own state, so they are
  // kept here and merged into the participant list when it is rebuilt.
  const handsRef = useRef<Map<string, boolean>>(new Map());
  const asksRef = useRef<Map<string, 'camera' | 'screen'>>(new Map());
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  const snapshot = useCallback(() => {
    const all: Participant[] = [
      room.localParticipant,
      ...Array.from(room.remoteParticipants.values()),
    ];

    // The teacher's decision reaches LiveKit as a permission change, so the
    // buttons a student sees come from the media server's answer rather than
    // from the page they loaded an hour ago. Without this, a student the
    // teacher unmuted mid-lesson still had no microphone to click.
    const permissions = room.localParticipant.permissions;
    if (permissions) {
      const sources = permissions.canPublishSources ?? [];
      const allows = (source: ProtoTrackSource) =>
        // An empty list with canPublish set is LiveKit's "no restriction".
        sources.length > 0 ? sources.includes(source) : Boolean(permissions.canPublish);
      setAbilities({
        mic: allows(ProtoTrackSource.MICROPHONE),
        camera: allows(ProtoTrackSource.CAMERA),
        screen: allows(ProtoTrackSource.SCREEN_SHARE),
      });
    }

    setPeople(
      all.map((p) => ({
        identity: p.identity,
        name: p.name || p.identity,
        isHost: participantIsHost(p.metadata),
        isLocal: p === room.localParticipant,
        micOn: p.isMicrophoneEnabled,
        camOn: p.isCameraEnabled,
        sharing: p.isScreenShareEnabled,
        speaking: p.isSpeaking,
        handUp: handsRef.current.get(p.identity) ?? false,
        asking: asksRef.current.get(p.identity) ?? null,
      })),
    );
  }, [room]);

  /**
   * The teacher's click should be felt, not just permitted.
   *
   * When a permission arrives mid-lesson — the false -> true edge — the
   * microphone and the camera start by themselves: the student raised a hand,
   * the teacher answered, and making them hunt for their own buttons afterwards
   * is the delay the approval was meant to remove. Joining a room where they
   * were already allowed auto-starts nothing, because nobody asked.
   */
  const previousAbilities = useRef<RoomAbilities | null>(null);
  useEffect(() => {
    const previous = previousAbilities.current;
    previousAbilities.current = abilities;
    const granted = newlyAllowed(previous, abilities);
    // A browser that refuses the device is not a failure: the button stays and
    // the student can still start it by hand.
    if (granted.mic) void room.localParticipant.setMicrophoneEnabled(true).catch(() => {});
    if (granted.camera) void room.localParticipant.setCameraEnabled(true).catch(() => {});
  }, [abilities, room]);

  useEffect(() => {
    let cancelled = false;

    async function connect() {
      try {
        const response = await fetch('/api/live/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ roomToken }),
        });
        if (!response.ok) {
          // 403 covers not entitled, removed, and class over — deliberately the
          // same answer, so the page says "the room is closed" rather than
          // telling a student which. Anything else is our fault, not theirs,
          // and is reported as such.
          const body = (await response.json().catch(() => null)) as { error?: string } | null;
          setError(response.status === 403 ? 'closed' : 'unavailable');
          setDetail(`HTTP ${response.status}${body?.error ? ` · ${body.error}` : ''}`);
          setStatus('failed');
          return;
        }
        const { token, url } = (await response.json()) as { token: string; url: string };
        if (cancelled) return;
        if (!url) {
          // The server has LiveKit credentials but no public URL to hand out,
          // which is a misconfiguration rather than a closed door.
          setError('unavailable');
          setDetail('NEXT_PUBLIC_LIVEKIT_URL is empty');
          setStatus('failed');
          return;
        }
        await room.connect(url, token);
        if (cancelled) return;
        setStatus('connected');
        snapshot();
      } catch (thrown) {
        if (!cancelled) {
          // Almost always the media server being unreachable: a wrong URL, a
          // server that is not running, or a firewall. Saying which beats
          // telling the teacher their own class was cancelled.
          setError('unavailable');
          setDetail(thrown instanceof Error ? thrown.message : String(thrown));
          setStatus('failed');
        }
      }
    }

    const onData = (payload: Uint8Array, from?: RemoteParticipant) => {
      const message = decodeMessage(payload);
      if (!message) return;
      const fromHost = participantIsHost(from?.metadata);
      // The rule that makes a student unable to drive the lesson: host-only
      // messages are dropped on receipt, whoever claims to have sent them.
      if (!acceptFrom(message, fromHost)) return;

      const identity = from?.identity ?? room.localParticipant.identity;
      if (message.t === 'hand') {
        handsRef.current.set(identity, message.up);
        snapshot();
      } else if (message.t === 'ask') {
        asksRef.current.set(identity, message.what);
        snapshot();
      } else if (message.t === 'chat') {
        setChat((lines) => [
          ...lines.slice(-199),
          {
            id: `${identity}-${Date.now()}-${lines.length}`,
            identity,
            name: from?.name || from?.identity || '',
            isHost: fromHost,
            body: message.body,
            at: Date.now(),
          },
        ]);
      }
      onMessageRef.current?.(message, fromHost);
    };

    const onLocalTrack = (pub: LocalTrackPublication) => {
      if (pub.source === Track.Source.Microphone) setMicOn(!pub.isMuted);
      if (pub.source === Track.Source.Camera) setCamOn(!pub.isMuted);
      if (pub.source === Track.Source.ScreenShare) setSharing(true);
      snapshot();
    };

    room
      .on(RoomEvent.ParticipantConnected, snapshot)
      .on(RoomEvent.ParticipantDisconnected, (p) => {
        handsRef.current.delete(p.identity);
        asksRef.current.delete(p.identity);
        snapshot();
      })
      .on(RoomEvent.TrackSubscribed, snapshot)
      .on(RoomEvent.TrackUnsubscribed, snapshot)
      .on(RoomEvent.TrackMuted, snapshot)
      .on(RoomEvent.TrackUnmuted, snapshot)
      .on(RoomEvent.ActiveSpeakersChanged, snapshot)
      .on(RoomEvent.LocalTrackPublished, onLocalTrack)
      .on(RoomEvent.LocalTrackUnpublished, (pub) => {
        if (pub.source === Track.Source.ScreenShare) setSharing(false);
        if (pub.source === Track.Source.Camera) setCamOn(false);
        if (pub.source === Track.Source.Microphone) setMicOn(false);
        snapshot();
      })
      .on(RoomEvent.DataReceived, onData)
      .on(RoomEvent.ConnectionStateChanged, (state) => {
        if (state === ConnectionState.Reconnecting) setStatus('reconnecting');
        if (state === ConnectionState.Connected) setStatus('connected');
      })
      .on(RoomEvent.Disconnected, (reason) => {
        // Being removed by the teacher is a normal outcome, not a fault, and
        // the page should say so rather than offering to reconnect.
        setStatus('closed');
        if (reason === DisconnectReason.PARTICIPANT_REMOVED) setError('removed');
      })
      // The teacher's decision reaches the media server, so our own permission
      // can change mid-lesson. Reflect it rather than leaving a dead button.
      .on(RoomEvent.ParticipantPermissionsChanged, snapshot);

    void connect();

    return () => {
      cancelled = true;
      room.disconnect();
    };
  }, [room, roomToken, snapshot]);

  const send = useCallback(
    (message: RoomMessage) => {
      if (room.state !== ConnectionState.Connected) return;
      void room.localParticipant.publishData(encodeMessage(message), { reliable: true });
    },
    [room],
  );

  /** Lossy for the in-progress stroke: a dropped point is invisible, a queue is not. */
  const sendLossy = useCallback(
    (message: RoomMessage) => {
      if (room.state !== ConnectionState.Connected) return;
      void room.localParticipant.publishData(encodeMessage(message), { reliable: false });
    },
    [room],
  );

  // A refusal here is the media server saying no — the permission changed
  // under the button, or the device is gone. The state stays as it was and
  // the button remains honest; the next permission change rebuilds it.
  const toggleMic = useCallback(async () => {
    const next = !room.localParticipant.isMicrophoneEnabled;
    try {
      await room.localParticipant.setMicrophoneEnabled(next);
      setMicOn(next);
    } catch {
      /* Refused or no device: leave the button as it was. */
    }
  }, [room]);

  const toggleCam = useCallback(async () => {
    const next = !room.localParticipant.isCameraEnabled;
    try {
      await room.localParticipant.setCameraEnabled(next);
      setCamOn(next);
    } catch {
      /* Refused or no device: leave the button as it was. */
    }
  }, [room]);

  const toggleShare = useCallback(async () => {
    const next = !room.localParticipant.isScreenShareEnabled;
    try {
      await room.localParticipant.setScreenShareEnabled(next, { audio: true });
      setSharing(next);
    } catch {
      /* Refused or no screen: leave the button as it was. */
    }
  }, [room]);

  const raiseHand = useCallback(
    (up: boolean) => {
      setHandUp(up);
      handsRef.current.set(room.localParticipant.identity, up);
      snapshot();
      send({ t: 'hand', up });
    },
    [room, send, snapshot],
  );

  const sendChat = useCallback(
    (body: string) => {
      const trimmed = body.trim().slice(0, 2000);
      if (!trimmed) return;
      send({ t: 'chat', body: trimmed });
      setChat((lines) => [
        ...lines.slice(-199),
        {
          id: `me-${Date.now()}`,
          identity: room.localParticipant.identity,
          name: room.localParticipant.name || '',
          isHost,
          body: trimmed,
          at: Date.now(),
        },
      ]);
    },
    [isHost, room, send],
  );

  const clearAsk = useCallback(
    (identity: string) => {
      asksRef.current.delete(identity);
      snapshot();
    },
    [snapshot],
  );

  return {
    room,
    status,
    error,
    detail,
    people,
    chat,
    setChat,
    micOn,
    camOn,
    sharing,
    handUp,
    abilities,
    send,
    sendLossy,
    sendChat,
    toggleMic,
    toggleCam,
    toggleShare,
    raiseHand,
    clearAsk,
  };
}
