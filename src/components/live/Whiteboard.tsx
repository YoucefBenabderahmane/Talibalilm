'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Eraser, Minus, Pen, Square, Trash2, Type } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { BoardOp } from '@/lib/live/protocol';

type Tool = 'pen' | 'line' | 'rect' | 'ellipse' | 'text' | 'eraser';

/**
 * The palette, each swatch paired with the message that names it.
 *
 * A hex code is not an accessible name: a screen reader announcing "#fbbf24"
 * tells the teacher nothing. The label is a `live` key and not the colour
 * itself so both locales get a word.
 */
const COLOURS = [
  { hex: '#f8fafc', label: 'colourWhite' },
  { hex: '#fbbf24', label: 'colourYellow' },
  { hex: '#34d399', label: 'colourGreen' },
  { hex: '#60a5fa', label: 'colourBlue' },
  { hex: '#f87171', label: 'colourRed' },
] as const;

/** Text height as a fraction of the board, and the line spacing under it. */
const TEXT_SIZE = 0.05;
const TEXT_LEADING = 1.25;

/**
 * The whiteboard.
 *
 * Drawn as operations, never as a picture. A stroke is a short list of points;
 * the board is the sum of the strokes. That matters three times over: the wire
 * carries a few hundred bytes instead of a megabyte per frame, a late joiner
 * replays the lesson's marks and arrives at the same board, and the database
 * can store a lesson's drawing in rows that a policy can actually protect.
 *
 * While a stroke is in progress it is published unreliably — a dropped point in
 * a line somebody is still drawing is invisible, whereas a queue of retries is
 * a board that lags behind the teacher's hand. The finished stroke is sent
 * reliably, and that is the one that counts.
 *
 * Students receive and render. They cannot draw: the control channel is the
 * teacher's, and every receiver drops a board op that did not come from them.
 */
export function Whiteboard({
  canDraw,
  history,
  onOp,
  onLiveOp,
  onClear,
  incoming,
}: {
  canDraw: boolean;
  /** Replayed once on entry, so somebody joining late sees the whole board. */
  history: BoardOp[];
  onOp: (op: BoardOp) => void;
  onLiveOp: (op: BoardOp) => void;
  onClear: () => void;
  /** Ops arriving from the teacher during the lesson. */
  incoming: { ops: BoardOp[]; clearedAt: number };
}) {
  const t = useTranslations('live');
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [tool, setTool] = useState<Tool>('pen');
  const [colour, setColour] = useState<string>(COLOURS[0].hex);
  const drawing = useRef(false);
  const points = useRef<number[]>([]);
  const start = useRef<{ x: number; y: number } | null>(null);
  /**
   * Where the caret is, when the text tool is in use.
   *
   * A `prompt()` was the quick way to get a string and the wrong way to write
   * on a board: it steals the screen, puts the words somewhere other than where
   * they will land, and in front of a class it looks like an error. Typing
   * happens on the board, at the point that was clicked.
   */
  const [typing, setTyping] = useState<{
    x: number;
    y: number;
    value: string;
    /** The committed text's height on this board, so the caret matches it. */
    px: number;
  } | null>(null);
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  /** A click that moves the caret blurs the textarea; that blur is not a commit. */
  const ignoreBlur = useRef(false);

  /** Ops are stored in a 0–1 space so every screen shows the same board. */
  const paint = useCallback((ctx: CanvasRenderingContext2D, op: BoardOp, W: number, H: number) => {
    ctx.strokeStyle = op.color;
    ctx.fillStyle = op.color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (op.t === 'stroke') {
      ctx.lineWidth = op.w;
      // The rubber takes ink away rather than laying the board's colour down:
      // what is under it shows through, so the board keeps whatever background
      // it is given, and replaying the lesson's ops lands on the same picture.
      if (op.erase) ctx.globalCompositeOperation = 'destination-out';
      ctx.beginPath();
      for (let i = 0; i + 1 < op.pts.length; i += 2) {
        const x = op.pts[i]! * W;
        const y = op.pts[i + 1]! * H;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      if (op.erase) ctx.globalCompositeOperation = 'source-over';
    } else if (op.t === 'shape') {
      ctx.lineWidth = op.lw;
      const x = op.x * W;
      const y = op.y * H;
      const w = op.w * W;
      const h = op.h * H;
      ctx.beginPath();
      if (op.kind === 'rect') ctx.rect(x, y, w, h);
      else if (op.kind === 'ellipse')
        ctx.ellipse(x + w / 2, y + h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, Math.PI * 2);
      else {
        ctx.moveTo(x, y);
        ctx.lineTo(x + w, y + h);
      }
      ctx.stroke();
    } else {
      // Enter writes a new line on the board, so a text op may hold several.
      const size = op.size * H;
      ctx.font = `${size}px system-ui, sans-serif`;
      ctx.textBaseline = 'top';
      op.s
        .split('\n')
        .slice(0, 40)
        .forEach((line, i) => ctx.fillText(line, op.x * W, op.y * H + i * size * TEXT_LEADING));
    }
  }, []);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const { width: W, height: H } = canvas;
    ctx.clearRect(0, 0, W, H);
    for (const op of history) paint(ctx, op, W, H);
    for (const op of incoming.ops) paint(ctx, op, W, H);
  }, [history, incoming.ops, paint]);

  // Keep the backing store matched to the element, or everything draws blurry
  // and the pointer lands somewhere other than the ink.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      redraw();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [redraw]);

  useEffect(redraw, [redraw, incoming.clearedAt]);

  const at = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) / rect.width,
      y: (event.clientY - rect.top) / rect.height,
    };
  };

  const width = tool === 'eraser' ? 24 : 3;
  const ink = tool === 'eraser' ? '#000000' : colour;
  const erasing = tool === 'eraser';

  const down = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!canDraw) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const p = at(event);
    start.current = p;

    if (tool === 'text') {
      drawing.current = false;
      // The click that moves the caret also blurs the textarea. That blur is
      // not a commit — the words move with the caret, they are not written by
      // leaving them — so the default that would take focus away is stopped
      // and the guard below covers browsers that do it anyway.
      event.preventDefault();
      ignoreBlur.current = true;
      commitText();
      const rect = event.currentTarget.getBoundingClientRect();
      // The last caret may have grown to three lines; a fresh one starts at one.
      if (textRef.current) textRef.current.style.height = '';
      setTyping({
        x: p.x,
        y: p.y,
        value: '',
        px: Math.max(12, Math.round(rect.height * TEXT_SIZE)),
      });
      requestAnimationFrame(() => {
        ignoreBlur.current = false;
        textRef.current?.focus();
      });
      return;
    }

    drawing.current = true;
    points.current = [p.x, p.y];
  };

  const move = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!canDraw || !drawing.current) return;
    const p = at(event);
    if (tool === 'pen' || tool === 'eraser') {
      points.current.push(p.x, p.y);
      // Unreliable on purpose: this stroke is still being drawn.
      if (points.current.length % 8 === 0) {
        onLiveOp({
          t: 'stroke',
          pts: points.current.slice(-16),
          color: ink,
          w: width,
          erase: erasing,
        });
      }
      const ctx = canvasRef.current?.getContext('2d');
      const canvas = canvasRef.current;
      if (ctx && canvas) {
        paint(
          ctx,
          { t: 'stroke', pts: points.current.slice(-4), color: ink, w: width, erase: erasing },
          canvas.width,
          canvas.height,
        );
      }
    }
  };

  const up = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!canDraw || !drawing.current) return;
    drawing.current = false;
    const p = at(event);
    const from = start.current;
    start.current = null;

    if (tool === 'pen' || tool === 'eraser') {
      if (points.current.length >= 4) {
        onOp({
          t: 'stroke',
          pts: points.current.slice(0, 4000),
          color: ink,
          w: width,
          erase: erasing,
        });
      }
      points.current = [];
    } else if (from) {
      const kind = tool === 'line' ? 'line' : tool === 'rect' ? 'rect' : 'ellipse';
      onOp({
        t: 'shape',
        kind,
        x: from.x,
        y: from.y,
        w: p.x - from.x,
        h: p.y - from.y,
        color: colour,
        lw: 3,
      });
    }
  };

  const commitText = useCallback(() => {
    setTyping((current) => {
      const body = current?.value.replace(/\s+$/, '');
      if (current && body?.trim()) {
        onOp({
          t: 'text',
          x: current.x,
          y: current.y,
          s: body.slice(0, 500),
          color: colour,
          size: TEXT_SIZE,
        });
      }
      return null;
    });
  }, [colour, onOp]);

  // T picks up the text tool, the way it does on every other board. Typing in
  // a field is typing in a field: the shortcut never steals a keystroke.
  useEffect(() => {
    if (!canDraw) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      ) {
        return;
      }
      if (event.key === 't' || event.key === 'T') setTool('text');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canDraw]);

  const toolButton = (value: Tool, Icon: typeof Pen, label: string) => (
    <button
      key={value}
      type="button"
      title={label}
      aria-pressed={tool === value}
      onClick={() => setTool(value)}
      className={cn(
        'inline-flex size-8 items-center justify-center rounded-lg transition-colors',
        tool === value
          ? 'bg-brand-500 text-white'
          : 'text-white/60 hover:bg-white/10 hover:text-white',
      )}
    >
      <Icon className="size-4" aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </button>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {canDraw && (
        <div className="flex flex-wrap items-center gap-1 border-b border-white/10 p-2">
          {toolButton('pen', Pen, t('boardPen'))}
          {toolButton('line', Minus, t('boardLine'))}
          {toolButton('rect', Square, t('boardRect'))}
          {toolButton('text', Type, `${t('boardTextTool')} (T)`)}
          {toolButton('eraser', Eraser, t('boardEraser'))}

          <span className="mx-1 h-5 w-px bg-white/15" aria-hidden="true" />

          {COLOURS.map(({ hex, label }) => (
            <button
              key={hex}
              type="button"
              onClick={() => {
                setColour(hex);
                if (tool === 'eraser') setTool('pen');
              }}
              aria-label={t(label)}
              aria-pressed={colour === hex && tool !== 'eraser'}
              className={cn(
                'size-5 rounded-full ring-2 transition-transform',
                colour === hex && tool !== 'eraser' ? 'ring-white scale-110' : 'ring-transparent',
              )}
              style={{ backgroundColor: hex }}
            />
          ))}

          <button
            type="button"
            onClick={() => {
              if (window.confirm(t('boardClearConfirm'))) onClear();
            }}
            title={t('boardClear')}
            className="ms-auto inline-flex size-8 items-center justify-center rounded-lg text-red-300 transition-colors hover:bg-red-500/20"
          >
            <Trash2 className="size-4" aria-hidden="true" />
            <span className="sr-only">{t('boardClear')}</span>
          </button>
        </div>
      )}

      {/* The caret sits over the canvas rather than in a dialogue: a prompt()
          steals the screen, puts the words somewhere other than where they will
          land, and in front of a class it looks like an error. */}
      <div className="relative min-h-0 flex-1">
        <canvas
          ref={canvasRef}
          data-record="main"
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
          className={cn(
            'size-full bg-ink',
            canDraw
              ? tool === 'text'
                ? 'cursor-text touch-none'
                : 'cursor-crosshair touch-none'
              : 'cursor-default',
          )}
        />

        {typing && (
          <textarea
            ref={textRef}
            autoFocus
            rows={1}
            wrap="off"
            value={typing.value}
            onChange={(event) => {
              const el = event.target;
              setTyping((c) => (c ? { ...c, value: el.value } : c));
              // Grow with the words, so a second line is not hidden behind a
              // scrollbar on a board the class is watching.
              el.style.height = 'auto';
              el.style.height = `${el.scrollHeight}px`;
            }}
            onBlur={() => {
              if (ignoreBlur.current) return;
              commitText();
            }}
            onKeyDown={(event) => {
              // Enter is a new line. Writing on a board is not submitting a
              // form, and a teacher numbering points types Enter by instinct.
              if (event.key === 'Escape') {
                event.preventDefault();
                setTyping(null);
              }
            }}
            maxLength={500}
            aria-label={t('boardText')}
            className="absolute min-w-[8ch] resize-none overflow-hidden border-b border-dashed border-white/40 bg-transparent p-0 whitespace-pre outline-none"
            style={{
              left: `${typing.x * 100}%`,
              top: `${typing.y * 100}%`,
              color: colour,
              fontSize: `${typing.px}px`,
              lineHeight: TEXT_LEADING,
            }}
          />
        )}
      </div>
    </div>
  );
}
