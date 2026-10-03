import { Suspense } from 'react';
import { getTranslations } from 'next-intl/server';
import { Award, Check, Gift, GraduationCap, Layers, MapPin, Plus, Video } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { SubmitButton } from '@/components/ui/submit-button';
import { PendingSpinner } from '@/components/ui/pending-spinner';
import { Badge } from '@/components/ui/badge';
import { CheckoutWizard, type WizardStep } from '@/components/checkout/CheckoutWizard';
import { FreeModuleClaim } from '@/components/checkout/FreeModuleClaim';
import { PaymentForms } from '@/components/checkout/PaymentForms';
import { CheckoutReturnError } from '@/components/checkout/CheckoutReturnError';
import { CheckoutProfileForm } from '@/components/checkout/CheckoutProfileForm';
import { CouponForm } from '@/components/checkout/CouponForm';
import {
  chooseCursus,
  chooseCursusYear,
  chooseDelivery,
  chooseInstallments,
  toggleProduct,
} from '@/app/actions/checkout';
import { loadBasket } from '@/lib/commerce/basket';
import { planDueDates, splitInstallments } from '@/lib/commerce/plan';
import { formatPrice } from '@/lib/commerce/quote';
import {
  getProgramme,
  listCursus,
  listProducts,
  programmeByYear,
  type ProgrammeEntry,
} from '@/lib/data/commerce';
import { getStudentProfile, isApproved, profileComplete } from '@/lib/data/profile';
import { isAllowedProviderEmail } from '@/lib/validation/email-providers';
import { getPayPalPublicConfig } from '@/lib/paypal/client';
import { createClient } from '@/lib/supabase/server';
import { supabaseConfigured } from '@/lib/env';
import { safeLocale } from '@/i18n/routing';

const CARD =
  'relative rounded-[var(--radius-card)] border p-5 text-start transition-colors';
const CARD_ON = 'border-brand-400 bg-brand-50/60';
const CARD_OFF = 'border-line bg-white hover:border-brand-300';

/**
 * The whole enrolment, in one card.
 *
 * Everything that decides a number happens here, on the server: the catalogue
 * is read, the basket is priced by `priceSelection`, and only finished markup
 * crosses into the browser. The wizard around it moves between panels and
 * nothing else.
 *
 * It lives on a module's page and nowhere else: there is no standalone
 * checkout, because the student who has just read what is taught should enrol
 * there rather than be sent to a separate shop to pick a module again.
 */
export async function CheckoutFlow({
  locale,
  moduleContext,
}: {
  locale: string;
  /**
   * The module the card stands on. It is the subject, so the first step is not
   * "which cursus" in the abstract but the two ways this subject is bought:
   * **this module** (always, once it has a price), or each approfondi whose
   * programme contains it. The module list stays hidden (the module is already
   * known); choosing the approfondi brings the years step back.
   *
   * A selection left over from another module's page is ignored, so this page
   * never shows somebody else's basket — but an approfondi choice is kept: it
   * is an answer to this page's own first question. A choice of a route this
   * page no longer offers is ignored too, for the same reason.
   */
  moduleContext: {
    courseId: string;
    /** The module's public path — the sign-in round trip returns here. */
    slug: string;
    title: string;
    /** The module has a published tariff, so it can be bought on its own. */
    hasTariff: boolean;
    /** The published approfondi cursus whose programme contains this module. */
    approfondiId: string | null;
    /**
     * Modes whose published price is zero, and modes priced above zero. The
     * first decides whether the page offers direct access; the second keeps
     * the ordinary checkout when anything about the module costs money.
     */
    freeModes: ('presentiel' | 'online')[];
    paidModes: ('presentiel' | 'online')[];
  };
}) {
  const t = await getTranslations('checkout');

  const [{ selection, quote, coupon }, cursusList] = await Promise.all([
    loadBasket(),
    listCursus(),
  ]);

  // A basket that belongs to ANOTHER module's page is not this page's. An
  // approfondi choice is this page's answer even though it names no module, so
  // it survives; only a module basket for a different course is ignored.
  const stale = selection.kind === 'module' && selection.courseId !== moduleContext.courseId;

  // A cookie can also name a route this page no longer offers — the office
  // removed the module from the cursus, or unpublished its price. Treated as
  // unanswered rather than showing a card that is not there.
  const offered =
    selection.kind === null ||
    (selection.kind === 'module'
      ? moduleContext.hasTariff
      : selection.cursusId !== null && selection.cursusId === moduleContext.approfondiId);

  const ignored = stale || !offered;
  const kind = ignored ? null : selection.kind;
  const delivery = ignored ? null : selection.delivery;
  const cursusId = ignored ? null : selection.cursusId;
  const priced = ignored ? null : quote;

  const products = delivery ? await listProducts(delivery) : [];
  const isApprofondi = kind === 'approfondi';
  const chosen = new Set(stale ? [] : selection.productIds);

  const modules = products.filter((p) => p.kind === 'module');
  const years = products
    .filter((p) => p.kind === 'cursus' && p.cursusId === cursusId)
    .sort((a, b) => a.yearIndex - b.yearIndex);

  const programme =
    isApprofondi && cursusId && delivery
      ? programmeByYear(await getProgramme(cursusId, delivery))
      : new Map<number, ProgrammeEntry[]>();

  // What the plan would look like, computed the same way the order will
  // compute it — the student sees the three amounts before choosing.
  const planAmounts = priced ? splitInstallments(priced.totalCents, selection.installments) : [];
  const planDates = planDueDates(new Date(), selection.installments);
  const planDateFmt = new Intl.DateTimeFormat(safeLocale(locale), { dateStyle: 'long' });

  // Signing in is required to pay, because an entitlement has to belong to
  // somebody. The selection survives in its cookie across the round trip.
  let signedIn = false;
  if (supabaseConfigured) {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    signedIn = user !== null;
  }

  // The student's enrolment details, asked once and required before payment.
  // Fetched here rather than in the panel so the wizard knows whether the step
  // is answered before it renders anything.
  const profile = signedIn ? await getStudentProfile() : null;
  const detailsComplete = profileComplete(profile);

  // New orders are reserved for the mailbox providers the school accepts. The
  // pay actions enforce it; saying it here, before the payment card, means the
  // student learns it from a sentence rather than from a refused PayPal popup.
  const emailAllowed = isAllowedProviderEmail(profile?.email);

  // The school lets accounts in deliberately. An account that has not been
  // approved can fill everything in and see the total; it cannot pay.
  const approved = signedIn ? await isApproved() : false;

  // A module the school gives away does not go through a checkout that will
  // never ask for money: one button, and the lessons are open. The enrolment
  // details are still required — the institute keeps a record of who is
  // enrolled — so an incomplete profile gets the form itself, in place.
  //
  // Only when NOTHING about the module is priced: a module free in one mode
  // and paid in the other still needs both figures in front of the student.
  if (moduleContext.paidModes.length === 0 && moduleContext.freeModes.length > 0) {
    return (
      <div className="rounded-[var(--radius-card)] border border-brand-200 bg-brand-50/40 p-6 text-center sm:p-8">
        <span
          className="mx-auto flex size-11 items-center justify-center rounded-full bg-brand-100 text-brand-600"
          aria-hidden="true"
        >
          <Gift className="size-5" />
        </span>
        <h3 className="mt-4 font-display text-lg font-semibold text-ink">
          {t('freeModuleTitle')}
        </h3>
        <p className="mx-auto mt-2 max-w-md text-[13px] leading-relaxed text-ink-muted">
          {t('freeModuleLead')}
        </p>

        {!signedIn ? (
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <Button asChild size="md">
              <Link
                href={`/login?next=${encodeURIComponent(`/courses/${moduleContext.slug}`)}`}
              >
                {t('loginCta')}
              </Link>
            </Button>
            <Button asChild size="md" variant="outline">
              <Link href="/register">{t('registerCta')}</Link>
            </Button>
          </div>
        ) : !approved ? (
          <div className="mx-auto mt-6 max-w-md rounded-[var(--radius-card)] border border-gold-300 bg-gold-50/60 p-5 text-start">
            <p className="text-[13px] font-medium text-ink">{t('approvalPendingTitle')}</p>
            <p className="mt-1 text-[12px] leading-relaxed text-ink-muted">
              {t('approvalPendingBody')}
            </p>
          </div>
        ) : !detailsComplete ? (
          <div className="mx-auto mt-6 max-w-xl text-start">
            <p className="mb-4 text-[13px] text-ink-muted">{t('profileRequired')}</p>
            <CheckoutProfileForm profile={profile} email={profile?.email ?? null} />
          </div>
        ) : !emailAllowed ? (
          <div className="mx-auto mt-6 max-w-md rounded-[var(--radius-card)] border border-gold-300 bg-gold-50/60 p-5 text-start">
            <p className="text-[13px] font-medium text-ink">{t('emailProviderTitle')}</p>
            <p className="mt-1 text-[12px] leading-relaxed text-ink-muted">
              {t('emailProviderBody')}
            </p>
          </div>
        ) : (
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            {moduleContext.freeModes.map((mode) => (
              <FreeModuleClaim
                key={mode}
                courseId={moduleContext.courseId}
                delivery={mode}
                label={
                  moduleContext.freeModes.length === 1
                    ? t('freeAccess')
                    : mode === 'presentiel'
                      ? t('modePresentiel')
                      : t('modeOnline')
                }
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  // Public config only — the client id, the currency and the environment. The
  // secret never leaves the server module it is read in.
  const paypal = await getPayPalPublicConfig();

  const allSteps: WizardStep[] = [
    {
      key: 'cursus',
      label: t('steps.formule'),
      heading: t('steps.formule'),
      lead: t('formuleLead'),
      complete: kind !== null,
      panel:
        moduleContext.hasTariff || moduleContext.approfondiId !== null ? (
          <ul className="grid gap-4 sm:grid-cols-2">
            {moduleContext.hasTariff && (
              <li>
                <form action={chooseCursus} className="h-full">
                  <input type="hidden" name="kind" value="module" />
                  <input type="hidden" name="courseId" value={moduleContext.courseId} />
                  <button
                    type="submit"
                    aria-pressed={kind === 'module'}
                    className={`${CARD} flex h-full w-full flex-col items-start ${
                      kind === 'module' ? CARD_ON : CARD_OFF
                    }`}
                  >
                    <span
                      className="flex size-10 items-center justify-center rounded-lg bg-brand-50 text-brand-600"
                      aria-hidden="true"
                    >
                      <Layers className="size-5" />
                    </span>
                    <span className="mt-4 font-display text-[16px] font-semibold text-ink">
                      {t('buyModule')}
                    </span>
                    <span className="mt-2 text-[13px] leading-relaxed text-ink-muted">
                      {moduleContext.title} — {t('buyModuleBody')}
                    </span>
                    <span className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-brand-50 px-2.5 py-1 text-[11px] font-medium text-brand-700">
                      <Award className="size-3.5" aria-hidden="true" />
                      {t('certificationModule')}
                    </span>
                    <PendingSpinner className="absolute end-4 top-4 text-brand-600" />
                  </button>
                </form>
              </li>
            )}

            {cursusList
              .filter((option) => option.id === moduleContext.approfondiId)
              .map((option) => {
                const on = kind === 'approfondi' && cursusId === option.id;
                return (
                  <li key={option.id}>
                    <form action={chooseCursus} className="h-full">
                      <input type="hidden" name="kind" value="approfondi" />
                      <input type="hidden" name="cursusId" value={option.id} />
                      <button
                        type="submit"
                        aria-pressed={on}
                        className={`${CARD} flex h-full w-full flex-col items-start ${
                          on ? CARD_ON : CARD_OFF
                        }`}
                      >
                        <span
                          className="flex size-10 items-center justify-center rounded-lg bg-brand-50 text-brand-600"
                          aria-hidden="true"
                        >
                          <GraduationCap className="size-5" />
                        </span>
                        <span className="mt-4 font-display text-[16px] font-semibold text-ink">
                          {option.title}
                        </span>
                        <span className="mt-2 text-[13px] leading-relaxed text-ink-muted">
                          {option.subtitle || t('cursusApprofondiBody')}
                        </span>
                        <span className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-brand-50 px-2.5 py-1 text-[11px] font-medium text-brand-700">
                          <Award className="size-3.5" aria-hidden="true" />
                          {t('certificationApprofondi')}
                        </span>
                        {option.yearCount > 1 && (
                          <span className="mt-2 text-[11px] text-brand-600">
                            {t('yearLabel', { year: option.yearCount })}
                          </span>
                        )}
                        <PendingSpinner className="absolute end-4 top-4 text-brand-600" />
                      </button>
                    </form>
                  </li>
                );
              })}
          </ul>
        ) : (
          <Empty>{t('formuleNone')}</Empty>
        ),
    },
    {
      key: 'mode',
      label: t('steps.mode'),
      heading: t('steps.mode'),
      lead: t('modeLead'),
      complete: delivery !== null,
      panel: (
        <ul className="grid gap-4 sm:grid-cols-2">
          {(
            [
              {
                value: 'presentiel',
                Icon: MapPin,
                name: t('modePresentiel'),
                body: t('modePresentielBody'),
              },
              { value: 'online', Icon: Video, name: t('modeOnline'), body: t('modeOnlineBody') },
            ] as const
          ).map(({ value, Icon, name, body }) => {
            const on = delivery === value;
            return (
              <li key={value}>
                <form action={chooseDelivery} className="h-full">
                  <input type="hidden" name="delivery" value={value} />
                  {/* No hidden kind/course here: the first step has already
                      written them, and posting `kind=module` unconditionally
                      would silently undo a student who chose the approfondi.
                      `chooseDelivery` reads the selection when a field is
                      absent. */}
                  <button
                    type="submit"
                    aria-pressed={on}
                    className={`${CARD} flex h-full w-full flex-col items-start ${on ? CARD_ON : CARD_OFF}`}
                  >
                    <span
                      className="flex size-10 items-center justify-center rounded-lg bg-brand-50 text-brand-600"
                      aria-hidden="true"
                    >
                      <Icon className="size-5" />
                    </span>
                    <span className="mt-4 font-display text-[16px] font-semibold text-ink">
                      {name}
                    </span>
                    <span className="mt-2 text-[13px] leading-relaxed text-ink-muted">{body}</span>
                    <PendingSpinner className="absolute end-4 top-4 text-brand-600" />
                  </button>
                </form>
              </li>
            );
          })}
        </ul>
      ),
    },
    {
      key: 'modules',
      label: t('steps.modules'),
      heading: t('steps.modules'),
      lead: isApprofondi ? t('modulesLeadApprofondi') : t('modulesLeadModule'),
      complete: selection.productIds.length > 0,
      panel: !delivery ? (
        <Empty>{t('modulesEmpty')}</Empty>
      ) : isApprofondi ? (
        years.length === 0 ? (
          <Empty>{t('modulesEmpty')}</Empty>
        ) : (
          <ul className="space-y-4">
            {years.map((year) => (
              <li
                key={year.id}
                className="rounded-[var(--radius-card)] border border-line bg-white p-5"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-3">
                  <h4 className="font-display text-[16px] font-semibold text-ink">
                    {t('yearLabel', { year: year.yearIndex })}
                  </h4>
                  <p className="font-display text-xl font-semibold text-brand-600">
                    {formatPrice(year.priceCents, locale)}
                  </p>
                </div>

                <ul className="mt-4 space-y-1.5">
                  {(programme.get(year.yearIndex) ?? []).map((entry) => (
                    <li
                      key={entry.courseId}
                      className="flex items-start gap-2 text-[13px] text-ink-muted"
                    >
                      <Check
                        className="mt-0.5 size-3.5 shrink-0 text-brand-500"
                        aria-hidden="true"
                      />
                      <Link
                        href={`/courses/${entry.courseSlug}`}
                        className="transition-colors hover:text-brand-600"
                      >
                        {entry.courseTitle}
                      </Link>
                    </li>
                  ))}
                </ul>

                <form action={chooseCursusYear} className="mt-5">
                  <input type="hidden" name="productId" value={year.id} />
                  <SubmitButton
                    size="md"
                    variant={chosen.has(year.id) ? 'outline' : 'primary'}
                  >
                    {chosen.has(year.id) ? t('selected') : t('select')}
                  </SubmitButton>
                </form>
              </li>
            ))}
          </ul>
        )
      ) : modules.length === 0 ? (
        <Empty>{t('modulesEmpty')}</Empty>
      ) : (
        <>
          <ul className="space-y-2">
            {modules.map((product) => {
              const picked = chosen.has(product.id);
              return (
                <li key={product.id}>
                  <form action={toggleProduct}>
                    <input type="hidden" name="productId" value={product.id} />
                    <button
                      type="submit"
                      aria-pressed={picked}
                      className={`${CARD} flex w-full flex-wrap items-center gap-3 !py-3 ${
                        picked ? CARD_ON : CARD_OFF
                      }`}
                    >
                      <span
                        className={`flex size-8 shrink-0 items-center justify-center rounded-lg ${
                          picked ? 'bg-brand-500 text-white' : 'bg-surface text-ink-muted'
                        }`}
                        aria-hidden="true"
                      >
                        {picked ? <Check className="size-4" /> : <Plus className="size-4" />}
                      </span>
                      <span className="min-w-0 flex-1 font-display text-[14px] font-semibold text-ink">
                        {product.title}
                      </span>
                      <span className="font-display text-[14px] font-semibold text-ink">
                        {formatPrice(product.priceCents, locale)}
                      </span>
                      <PendingSpinner className="text-brand-600" />
                    </button>
                  </form>
                </li>
              );
            })}
          </ul>
          <p className="mt-4">
            <Badge variant="soft">{t('chosen', { count: chosen.size })}</Badge>
          </p>
        </>
      ),
    },
    {
      key: 'info',
      label: t('steps.info'),
      heading: t('infoHeading'),
      lead: t('infoLead'),
      complete: detailsComplete,
      panel: !signedIn ? (
        /* Accounts first, then details and payment — an entitlement has to
           belong to somebody, and the basket survives the round trip in its
           cookie. */
        <div className="rounded-[var(--radius-card)] border border-line bg-surface/50 p-5">
          <p className="text-[13px] text-ink-muted">{t('loginRequired')}</p>
          <div className="mt-4 flex flex-wrap gap-3">
            <Button asChild size="md">
              <Link href="/register">{t('registerCta')}</Link>
            </Button>
            <Button asChild size="md" variant="outline">
              <Link
                href={`/login?next=${encodeURIComponent(
                  `/courses/${moduleContext.slug}#inscription`,
                )}`}
              >
                {t('loginCta')}
              </Link>
            </Button>
          </div>
        </div>
      ) : (
        <CheckoutProfileForm profile={profile} email={profile?.email ?? null} />
      ),
    },
    {
      key: 'payment',
      label: t('steps.payment'),
      heading: t('payTitle'),
      lead: t('payLead'),
      complete: priced !== null && detailsComplete,
      panel: !priced ? (
        <Empty>{delivery ? t('moduleNotSoldInMode') : t('emptyBasket')}</Empty>
      ) : (
        <>
          {/* A failed PayPal redirect arrives with `?error=`; the client
              component reads it so this page never needs `searchParams`. */}
          <Suspense fallback={null}>
            <CheckoutReturnError />
          </Suspense>

          {/*
            What is being bought, on the same screen as the button that buys
            it. This used to be its own step — a "Récapitulatif" that asked the
            student to confirm a list before showing the payment, which is one
            screen more than the decision needs.
          */}
          <div className="rounded-[var(--radius-card)] border border-line">
            <ul className="divide-y divide-line">
              {priced.lines.map((line) => (
                <li key={line.productId} className="flex flex-wrap items-center gap-3 p-4">
                  <div className="min-w-0 flex-1">
                    <p className="font-display text-[14px] font-semibold text-ink">{line.title}</p>
                    <p className="mt-0.5 text-[11px] text-ink-muted">
                      {t('duration', { days: line.durationDays })}
                    </p>
                  </div>
                  {line.isFree ? (
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] text-ink-muted line-through">
                        {formatPrice(line.listPriceCents, locale)}
                      </span>
                      <Badge variant="success">{t('offerFree')}</Badge>
                    </div>
                  ) : (
                    <span className="font-display text-[14px] font-semibold text-ink">
                      {formatPrice(line.unitPriceCents, locale)}
                    </span>
                  )}
                </li>
              ))}
            </ul>

            {priced.pack && (
              <p className="flex items-center gap-2 border-t border-line bg-brand-50/60 px-4 py-3 text-[13px] text-brand-700">
                <Gift className="size-4 shrink-0" aria-hidden="true" />
                {t('offerApplied', { name: priced.pack.title })}
              </p>
            )}

            <dl className="space-y-2 border-t border-line p-4 text-[13px]">
              <div className="flex justify-between text-ink-muted">
                <dt>{t('subtotal')}</dt>
                <dd>{formatPrice(priced.subtotalCents, locale)}</dd>
              </div>
              {priced.discountCents > 0 && (
                <div className="flex justify-between text-brand-600">
                  <dt>{t('discount')}</dt>
                  <dd>−{formatPrice(priced.discountCents, locale)}</dd>
                </div>
              )}
              <div className="flex items-baseline justify-between border-t border-line pt-2 font-display text-lg font-semibold text-ink">
                <dt>{t('total')}</dt>
                <dd className="flex items-baseline gap-2">
                  {/* The old price stays visible when a code or an offer moves
                      it, so the reduction is a fact rather than a memory. */}
                  {priced.discountCents > 0 && (
                    <span className="text-[13px] font-normal text-ink-muted line-through">
                      {formatPrice(priced.subtotalCents, locale)}
                    </span>
                  )}
                  <span>{formatPrice(priced.totalCents, locale)}</span>
                </dd>
              </div>
            </dl>
          </div>

          {/*
            ONE card for the whole payment: the code, then the two ways to pay.
            The code used to sit in its own dashed box above the PayPal button
            and the desk card, which read as two separate offers rather than
            one payment screen.
          */}
          <div className="mt-5 rounded-[var(--radius-card)] border border-line bg-white p-5">
            {/* How many payments. Only when there is something to split: a
                basket the school is giving away has no schedule. */}
            {priced.totalCents > 0 && (
              <div className="mb-5 border-b border-line pb-5">
                <p className="text-[13px] font-medium text-ink">{t('installmentsTitle')}</p>
                <p className="mt-1 text-[11px] leading-relaxed text-ink-muted">
                  {t('installmentsLead')}
                </p>

                <div className="mt-3 flex flex-wrap gap-2">
                  {([1, 3] as const).map((count) => {
                    const on = selection.installments === count;
                    return (
                      <form action={chooseInstallments} key={count}>
                        <input type="hidden" name="installments" value={count} />
                        <button
                          type="submit"
                          aria-pressed={on}
                          className={`relative rounded-full border px-4 py-2 text-[12px] font-medium transition-colors ${
                            on
                              ? 'border-brand-400 bg-brand-50 text-brand-700'
                              : 'border-line text-ink-muted hover:border-brand-300'
                          }`}
                        >
                          {count === 1 ? t('installmentsOnce') : t('installmentsThree')}
                          <PendingSpinner className="absolute end-2 top-1/2 -translate-y-1/2 text-brand-600" />
                        </button>
                      </form>
                    );
                  })}
                </div>

                {selection.installments > 1 && (
                  <ul className="mt-4 space-y-1.5 text-[12px] text-ink-muted">
                    {planAmounts.map((amount, index) => (
                      <li key={index} className="flex flex-wrap items-baseline justify-between gap-2">
                        <span>
                          {index === 0
                            ? t('installmentsToday')
                            : t('installmentsNumber', { n: index + 1 })}
                          {index > 0 && ` — ${planDateFmt.format(planDates[index]!)}`}
                        </span>
                        <span className="font-medium text-ink tabular-nums">
                          {formatPrice(amount, locale)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            <CouponForm
              defaultValue={selection.couponCode ?? ''}
              coupon={coupon}
              totalCents={priced.totalCents}
              locale={locale}
            />

            <div className="mt-5 border-t border-line pt-5">
              {signedIn && !approved ? (
                <div className="rounded-[var(--radius-card)] border border-gold-300 bg-gold-50/60 p-5">
                  <p className="text-[13px] font-medium text-ink">
                    {t('approvalPendingTitle')}
                  </p>
                  <p className="mt-1 text-[12px] leading-relaxed text-ink-muted">
                    {t('approvalPendingBody')}
                  </p>
                </div>
              ) : signedIn && !emailAllowed ? (
                <div className="rounded-[var(--radius-card)] border border-gold-300 bg-gold-50/60 p-5">
                  <p className="text-[13px] font-medium text-ink">{t('emailProviderTitle')}</p>
                  <p className="mt-1 text-[12px] leading-relaxed text-ink-muted">
                    {t('emailProviderBody')}
                  </p>
                </div>
              ) : (
                <PaymentForms paypal={paypal} free={priced.totalCents === 0} locale={locale} />
              )}
            </div>
          </div>
        </>
      ),
    },
  ];

  // On a module's own page the module list is not a question: the module is
  // the subject. The years step stays, because choosing the approfondi route
  // means choosing a year. The route question itself is the first step — see
  // the cursus panel above.
  const steps =
    kind !== 'approfondi' ? allSteps.filter((step) => step.key !== 'modules') : allSteps;

  return (
    <CheckoutWizard
      steps={steps}
      labels={{
        next: t('continue'),
        back: t('backStep'),
        nav: t('title'),
        step: steps.map((_, index) => t('step', { current: index + 1, total: steps.length })),
      }}
    />
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-[var(--radius-card)] border border-dashed border-line bg-surface/50 p-8 text-center text-sm text-ink-muted">
      {children}
    </p>
  );
}
