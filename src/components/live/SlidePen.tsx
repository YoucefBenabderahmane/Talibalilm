'use client';

import { useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Eraser, Pencil, Undo2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { addPoint, PEN_COLORS, PEN_WIDTH, toCanvasPoint, type Stroke } from '@/lib/live/marks';

/** What the room lends the slide so the teacher can draw on it. */
export interface SlideAnnotate {
  /** The canvas the page is drawn on, which the class is watching. */
  canvas: () => HTMLCanvasElement | null;
  on: boolean;
  color: string;
  onToggle: () => void;
  onColor: (color: string) => void;
  /** A stroke in progress: draw its points from `from` on. */
  onDraw: (stroke: Stroke, from: number) => void;
  /** A finished stroke, to keep with the page. */
  onDone: (stroke: Stroke) => void;
  hasMarks: boolean;
  onUndo: () => void;
  onClear: () => void;
}

/**
 * The pen, over the slide on the teacher's stage.
 *
 * The toolbar sits in the slide's top-left corner, the corner the fullscreen
 * button does not use. While the pen is on, a layer over the page takes the
 * pointer: a drag draws instead of panning a zoomed page, and the class sees
 * each stroke as it is made.
 */
export function SlidePen({
  canvas,
  on,
  color,
  onToggle,
  onColor,
  onDraw,
  onDone,
  hasMarks,
  onUndo,
  onClear,
}: SlideAnnotate) {
  const t = useTranslations('live');
  /**
   * The stroke being drawn, with the callbacks of the page it began on: a
   * page turned mid-stroke must not receive the end of it.
   */
  const current = useRef<{
    stroke: Stroke;
    element: HTMLCanvasElement;
    draw: SlideAnnotate['onDraw'];
    done: SlideAnnotate['onDone'];
  } | null>(null);

  const point = (element: HTMLCanvasElement, clientX: number, clientY: number) =>
    toCanvasPoint(clientX, clientY, element.getBoundingClientRect(), element.width, element.height);

  const finish = () => {
    const stroke = current.current;
    current.current = null;
    if (stroke) stroke.done(stroke.stroke);
  };

  return (
    <>
      {on && (
        <div
          data-slide-pen
          className="absolute inset-0 z-10 cursor-crosshair touch-none"
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            const element = canvas();
            if (!element) return;
            // Drawing, not panning: the zoom surface under this layer must not
            // start a drag of its own.
            event.stopPropagation();
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            const start = point(element, event.clientX, event.clientY);
            const stroke: Stroke = { color, width: PEN_WIDTH, points: [start.x, start.y] };
            current.current = { stroke, element, draw: onDraw, done: onDone };
            onDraw(stroke, 0);
          }}
          onPointerMove={(event) => {
            const active = current.current;
            if (!active) return;
            event.stopPropagation();
            const from = active.stroke.points.length;
            // Every sample the pointer took since the last event: a quick
            // circle stays round instead of turning into a polygon.
            const samples = event.nativeEvent.getCoalescedEvents?.() ?? [];
            for (const sample of samples.length > 0 ? samples : [event.nativeEvent]) {
              const p = point(active.element, sample.clientX, sample.clientY);
              addPoint(active.stroke.points, p.x, p.y);
            }
            if (active.stroke.points.length > from) active.draw(active.stroke, from);
          }}
          onPointerUp={finish}
          onPointerCancel={finish}
          onLostPointerCapture={finish}
        />
      )}

      <div
        className="absolute start-3 top-3 z-20 flex items-center gap-1 rounded-full bg-black/60 p-1 text-white backdrop-blur"
        // A click on the toolbar is never the start of a stroke or a pan.
        onPointerDown={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          onClick={onToggle}
          aria-pressed={on}
          title={on ? t('penOff') : t('penOn')}
          className={cn(
            'inline-flex size-8 items-center justify-center rounded-full transition-colors',
            on ? 'bg-white text-black' : 'text-white/85 hover:bg-white/15 hover:text-white',
          )}
        >
          <Pencil className="size-4" aria-hidden="true" />
          <span className="sr-only">{on ? t('penOff') : t('penOn')}</span>
        </button>

        {on && (
          <>
            {PEN_COLORS.map((choice) => (
              <button
                key={choice.key}
                type="button"
                onClick={() => onColor(choice.value)}
                aria-pressed={color === choice.value}
                title={t(`penColor.${choice.key}`)}
                className={cn(
                  'inline-flex size-7 items-center justify-center rounded-full transition-transform',
                  color === choice.value ? 'ring-2 ring-white' : 'hover:scale-110',
                )}
              >
                <span
                  className="size-4 rounded-full ring-1 ring-black/40"
                  style={{ backgroundColor: choice.value }}
                />
                <span className="sr-only">{t(`penColor.${choice.key}`)}</span>
              </button>
            ))}

            <span className="mx-0.5 h-5 w-px bg-white/20" aria-hidden="true" />

            <button
              type="button"
              onClick={onUndo}
              disabled={!hasMarks}
              title={t('penUndo')}
              className="inline-flex size-8 items-center justify-center rounded-full text-white/85 transition-colors hover:bg-white/15 hover:text-white disabled:opacity-30"
            >
              <Undo2 className="size-4" aria-hidden="true" />
              <span className="sr-only">{t('penUndo')}</span>
            </button>
            <button
              type="button"
              onClick={() => {
                if (window.confirm(t('penClearConfirm'))) onClear();
              }}
              disabled={!hasMarks}
              title={t('penClear')}
              className="inline-flex size-8 items-center justify-center rounded-full text-white/85 transition-colors hover:bg-red-600 hover:text-white disabled:opacity-30"
            >
              <Eraser className="size-4" aria-hidden="true" />
              <span className="sr-only">{t('penClear')}</span>
            </button>
          </>
        )}
      </div>
    </>
  );
}
