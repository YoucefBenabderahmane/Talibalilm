'use client';

import { useId, useState, type ReactNode } from 'react';
import Image from 'next/image';
import { Award, ChevronDown } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** Lines the office wrote as headings, told apart by their leading emoji. */
const HEADING_STARTS = ['📚', '✨', '➡️', '💳', '🎓', '📖', '⚠️', '🔸', '🔹'];

/**
 * One cursus, with its programme folded into the card.
 *
 * The programme used to be behind a link to another page. It is now an
 * accordion: "Voir le cursus" opens what the cursus covers — a written outline
 * and/or the office's own poster image — without leaving the page the visitor
 * was reading. The panel is present in the markup at all times and animated
 * with the grid-rows trick, so it opens without JavaScript and without a
 * measured height.
 */
export function CursusCard({
  slug,
  title,
  subtitle,
  description,
  details,
  imageUrl,
  yearCount,
  icon,
  certification,
  labels,
}: {
  slug: string;
  title: string;
  subtitle: string;
  description: string;
  details: string;
  imageUrl: string | null;
  yearCount: number;
  icon: ReactNode;
  certification: string;
  labels: { years: string; view: string; hide: string; enrol: string; programme: string };
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();

  const lines = details
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const hasProgramme = lines.length > 0 || imageUrl !== null;

  return (
    <li className="flex flex-col overflow-hidden rounded-[var(--radius-card)] border border-line bg-white shadow-card">
      <div className="flex items-center gap-4 bg-ink px-5 py-6 text-white sm:px-6">
        <span
          className="flex size-12 shrink-0 items-center justify-center rounded-full bg-gold-500"
          aria-hidden="true"
        >
          {icon}
        </span>
        <div className="min-w-0">
          <h3 className="font-display text-[18px] font-semibold">{title}</h3>
          {yearCount > 1 && <p className="mt-0.5 text-[12px] text-gold-300">{labels.years}</p>}
        </div>
      </div>

      <div className="flex flex-1 flex-col p-5 sm:p-6">
        <p className="text-[13px] leading-relaxed text-ink-muted">{description || subtitle}</p>

        {/* The same line the checkout shows on the same choice. Said in both
            places on purpose: it is the difference people actually ask about,
            and a visitor should not have to reach the payment screen to learn
            it. */}
        <p className="mt-4 inline-flex w-fit items-center gap-1.5 rounded-full bg-brand-50 px-2.5 py-1 text-[11px] font-medium text-brand-700">
          <Award className="size-3.5" aria-hidden="true" />
          {certification}
        </p>

        <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-3">
          <Button asChild size="sm" variant="outline">
            <Link href={`/cursus/${slug}`}>{labels.enrol}</Link>
          </Button>
          {hasProgramme && (
            <button
              type="button"
              onClick={() => setOpen((current) => !current)}
              aria-expanded={open}
              aria-controls={panelId}
              className="inline-flex items-center gap-1.5 text-[12px] font-semibold tracking-[0.08em] text-gold-700 uppercase transition-colors hover:text-gold-600"
            >
              {open ? labels.hide : labels.view}
              <ChevronDown
                className={cn('size-4 transition-transform duration-300', open && 'rotate-180')}
                aria-hidden="true"
              />
            </button>
          )}
        </div>

        {hasProgramme && (
          <div
            id={panelId}
            className={cn(
              'grid transition-[grid-template-rows,opacity] duration-300 ease-out',
              open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
            )}
          >
            <div className="overflow-hidden">
              <div className="mt-5 border-t border-line pt-5">
                <p className="text-[11px] font-semibold tracking-[0.14em] text-gold-600 uppercase">
                  {labels.programme}
                </p>

                {imageUrl && (
                  <Image
                    src={imageUrl}
                    alt={title}
                    width={1080}
                    height={1350}
                    sizes="(min-width: 768px) 50vw, 100vw"
                    className="mt-4 h-auto w-full rounded-[var(--radius-card)] border border-line"
                  />
                )}

                {lines.length > 0 && (
                  <div className="mt-4 space-y-1.5 text-[13px] leading-relaxed text-ink-muted">
                    {lines.map((line, index) => (
                      <p
                        key={`${index}-${line}`}
                        className={
                          HEADING_STARTS.some((start) => line.startsWith(start))
                            ? 'font-medium text-ink'
                            : undefined
                        }
                      >
                        {line}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </li>
  );
}
