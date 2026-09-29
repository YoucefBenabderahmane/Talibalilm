import { getTranslations } from 'next-intl/server';
import { Check, Minus, Plus } from 'lucide-react';
import { formatPrice, type PricedProduct } from '@/lib/commerce/quote';
import type { DeliveryMode } from '@/lib/supabase/database.types';

/**
 * Planning & Tarifs — the school's own timetable, priced.
 *
 * Two things about how this is built:
 *
 * The mode tabs are radio inputs and CSS sibling selectors, not React state.
 * That keeps the whole block a Server Component and the page statically
 * rendered: switching between on site and online costs no request, no
 * JavaScript, and works before hydration. Both panels are in the HTML, which
 * is fine — this is public pricing, not gated content.
 *
 * The slot groups are `<details>`, so the browser gives us disclosure
 * semantics, keyboard operation and find-in-page for free. The first slot in
 * each mode is open, matching the school's own page.
 */

export interface PlanningEntry extends PricedProduct {
  timeSlot: string;
  scheduleLabel: string;
  hoursPerYear: number | null;
  /** Tenths of an hour. */
  hoursPerWeek: number | null;
  teachingLanguage: string;
}

const MODES: DeliveryMode[] = ['presentiel', 'online'];

/** "semaine-soir" reads as "Semaine soir". The admin types the slug, so it can be edited. */
function slotLabel(slot: string): string {
  if (!slot) return '';
  const spaced = slot.replace(/-/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function groupBySlot(entries: PlanningEntry[]): [string, PlanningEntry[]][] {
  const slots = new Map<string, PlanningEntry[]>();
  for (const entry of entries) {
    slots.set(entry.timeSlot, [...(slots.get(entry.timeSlot) ?? []), entry]);
  }
  return [...slots.entries()];
}

export async function PlanningTarifs({
  entries,
  locale,
}: {
  entries: PlanningEntry[];
  locale: string;
}) {
  const t = await getTranslations('pricing');
  const tCheckout = await getTranslations('checkout');

  const byMode = {
    presentiel: entries.filter((e) => e.delivery === 'presentiel'),
    online: entries.filter((e) => e.delivery === 'online'),
  };

  if (entries.length === 0) return null;

  return (
    <section className="py-14 sm:py-16">
      <div className="shell">
        <h2 className="text-center font-display text-[clamp(1.5rem,3.4vw,2rem)] font-semibold text-brand-600">
          {t('planningTitle')}
        </h2>

        {/* The radios drive the panels below through `peer-checked`. They are
            visually hidden but still focusable, so the tabs are keyboard- and
            screen-reader-operable as a radio group. */}
        {/*
          Everything below is a direct child of the fieldset on purpose.
          `peer-checked` compiles to the general sibling combinator, so a label
          nested inside a wrapper div would never see the radio's state — the
          tabs would switch panels while staying visually unlit. The row is
          centred with `text-center` on the fieldset rather than a flex wrapper,
          and the panels put the alignment back.
        */}
        <fieldset className="mt-6 text-center">
          <legend className="sr-only">{t('planningTitle')}</legend>

          <input
            type="radio"
            name="planning-mode"
            id="planning-presentiel"
            defaultChecked
            className="peer/presentiel sr-only"
          />
          <input
            type="radio"
            name="planning-mode"
            id="planning-online"
            className="peer/online sr-only"
          />

          <label
            htmlFor="planning-presentiel"
            className="inline-block cursor-pointer bg-surface px-8 py-4 font-display text-[15px] text-ink-muted transition-colors peer-checked/presentiel:bg-brand-500 peer-checked/presentiel:text-white peer-focus-visible/presentiel:outline-2 peer-focus-visible/presentiel:outline-offset-2 peer-focus-visible/presentiel:outline-brand-600"
          >
            {tCheckout('modePresentiel')}
          </label>
          <label
            htmlFor="planning-online"
            className="inline-block cursor-pointer bg-surface px-8 py-4 font-display text-[15px] text-ink-muted transition-colors peer-checked/online:bg-brand-500 peer-checked/online:text-white peer-focus-visible/online:outline-2 peer-focus-visible/online:outline-offset-2 peer-focus-visible/online:outline-brand-600"
          >
            {tCheckout('modeOnline')}
          </label>

          {MODES.map((mode) => (
            <div
              key={mode}
              className={
                mode === 'presentiel'
                  ? 'mt-6 hidden text-start peer-checked/presentiel:block'
                  : 'mt-6 hidden text-start peer-checked/online:block'
              }
            >
              {byMode[mode].length === 0 ? (
                <p className="rounded-[var(--radius-card)] border border-dashed border-line bg-surface/50 p-8 text-center text-sm text-ink-muted">
                  {t('planningEmpty')}
                </p>
              ) : (
                <div className="space-y-2">
                  {groupBySlot(byMode[mode]).map(([slot, group], index) => (
                    <details
                      key={slot}
                      open={index === 0}
                      className="group overflow-hidden rounded-sm border border-line"
                    >
                      <summary className="flex cursor-pointer list-none items-center gap-3 bg-surface px-5 py-4 font-display text-[15px] text-ink transition-colors group-open:bg-brand-500 group-open:text-white">
                        <span aria-hidden="true">
                          <Plus className="size-4 group-open:hidden" />
                          <Minus className="hidden size-4 group-open:block" />
                        </span>
                        {tCheckout(mode === 'presentiel' ? 'modePresentiel' : 'modeOnline')}
                        {slot && ` — ${slotLabel(slot)}`}
                      </summary>

                      <ul className="divide-y divide-line">
                        {group.map((entry) => (
                          <li key={entry.id}>
                            <div className="bg-ink px-6 py-5 text-center text-white">
                              <p className="font-display text-lg font-semibold">{entry.title}</p>
                              <p className="mt-1 text-[13px] text-white/70">
                                {[
                                  entry.scheduleLabel,
                                  entry.hoursPerYear
                                    ? t('hoursYear', { n: entry.hoursPerYear })
                                    : null,
                                ]
                                  .filter(Boolean)
                                  .join(' — ')}
                              </p>
                            </div>

                            <div className="bg-white px-6 py-8 text-center">
                              <p className="font-display text-4xl font-semibold text-brand-600">
                                {formatPrice(entry.priceCents, locale)}
                              </p>

                              <ul className="mx-auto mt-6 max-w-sm divide-y divide-line">
                                {[
                                  tCheckout(
                                    entry.delivery === 'presentiel'
                                      ? 'modePresentiel'
                                      : 'modeOnline',
                                  ),
                                  entry.teachingLanguage === 'ar' ? 'العربية' : t('teachingFr'),
                                  entry.hoursPerWeek
                                    ? t('hoursWeek', { n: entry.hoursPerWeek / 10 })
                                    : null,
                                ]
                                  .filter((line): line is string => Boolean(line))
                                  .map((line) => (
                                    <li
                                      key={line}
                                      className="flex items-center justify-center gap-2 py-3 text-[13px] text-ink-soft"
                                    >
                                      <Check
                                        className="size-4 shrink-0 text-brand-500"
                                        aria-hidden="true"
                                      />
                                      {line}
                                    </li>
                                  ))}
                              </ul>
                            </div>
                          </li>
                        ))}
                      </ul>
                    </details>
                  ))}
                </div>
              )}
            </div>
          ))}
        </fieldset>
      </div>
    </section>
  );
}
